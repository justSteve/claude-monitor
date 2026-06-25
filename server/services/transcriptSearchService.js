/**
 * Transcript Search Service (co-1la2)
 *
 * Keyword/BM25-style search over CM's OWN ingested transcript corpus
 * (the `conversation_entries` table), which the scheduler populates from
 * EVERY zgent under /root/.claude/projects/-root-projects-*\/.
 *
 * Why this exists:
 *   Unified search previously sourced its "BM25 / transcript keyword" signal
 *   exclusively from the external CASS binary (cassSearchService). CASS is a
 *   separate, lazily-maintained index whose WSL store lags CM's ingestion by
 *   hundreds of conversations and whose Windows store is frequently missing.
 *   The net effect: content CM had already ingested (e.g. every non-COO zgent's
 *   sessions) was invisible to unified search even though it sat in CM's DB.
 *
 *   This service queries CM's own database instead. Because the scheduler
 *   ingests all zgents' transcripts, this signal automatically covers every
 *   current and future zgent with no external reindex.
 *
 * Contract: implements `search(query, { limit })` returning
 *   { query, total_matches, count, hits: [{ snippet, content, score, source_path, ... }] }
 * which is the same shape unifiedSearchService.fanOutBM25 already consumes from
 * cassSearchService, so it is a drop-in replacement for the `cassSearch` backend.
 */

import db from '../db/index.js';
import logger from './logService.js';

// Snippet window (chars) returned around the match for display.
const SNIPPET_MAX_CHARS = 400;

/**
 * Split a free-text query into distinct, non-trivial keyword terms.
 * Keeps tokens of length >= 2; lowercased; deduplicated.
 * @param {string} queryText
 * @returns {string[]}
 */
function tokenize(queryText) {
    const seen = new Set();
    const terms = [];
    for (const raw of String(queryText).toLowerCase().split(/[^a-z0-9_]+/)) {
        if (raw.length < 2) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);
        terms.push(raw);
    }
    return terms;
}

/**
 * Build a SNIPPET around the first occurrence of any term.
 * @param {string} content
 * @param {string[]} terms
 * @returns {string}
 */
function buildSnippet(content, terms) {
    if (!content) return '';
    const lower = content.toLowerCase();
    let firstIdx = -1;
    for (const term of terms) {
        const idx = lower.indexOf(term);
        if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) firstIdx = idx;
    }
    if (firstIdx === -1) return content.slice(0, SNIPPET_MAX_CHARS);

    const start = Math.max(0, firstIdx - Math.floor(SNIPPET_MAX_CHARS / 4));
    const snippet = content.slice(start, start + SNIPPET_MAX_CHARS);
    return (start > 0 ? '…' : '') + snippet + (start + SNIPPET_MAX_CHARS < content.length ? '…' : '');
}

/**
 * Count occurrences of a term in content (case-insensitive).
 * @param {string} lowerContent
 * @param {string} term
 * @returns {number}
 */
function countOccurrences(lowerContent, term) {
    let count = 0;
    let idx = lowerContent.indexOf(term);
    while (idx !== -1) {
        count++;
        idx = lowerContent.indexOf(term, idx + term.length);
    }
    return count;
}

/**
 * Search CM's ingested transcript corpus for the query terms.
 *
 * Scoring is a lightweight TF-style score (sum of term frequencies, with a
 * bonus for distinct-term coverage) rather than true BM25. It is deliberately
 * simple: the unified-search layer re-normalizes this via normalizeBM25() and
 * fuses it with the semantic + entity signals, so absolute scale is not load
 * bearing — only relative ranking within the BM25 signal matters.
 *
 * @param {string} query
 * @param {object} [filters]
 * @param {number} [filters.limit=20] - Max candidate rows to return.
 * @returns {Promise<{query, total_matches, count, hits: Array}>}
 */
async function search(query, filters = {}) {
    const { limit = 20 } = filters;
    const terms = tokenize(query);

    if (terms.length === 0) {
        return { query, total_matches: 0, count: 0, hits: [], sources_queried: ['cm-transcripts'] };
    }

    let rows;
    try {
        const database = db.getDb();

        // Candidate rows: any entry whose content matches ANY term (OR), so we
        // can score by coverage. Over-fetch (limit * 5, capped) before scoring
        // so the best matches survive ranking. Join to conversations/projects
        // for provenance in the returned source_path.
        const likeClauses = terms.map(() => 'ce.content LIKE ? COLLATE NOCASE').join(' OR ');
        const params = terms.map(t => `%${t}%`);
        const fetchLimit = Math.min(Math.max(limit * 5, 50), 500);

        const sql = `
            SELECT
                ce.content      AS content,
                ce.role         AS role,
                ce.timestamp    AS timestamp,
                c.source_file_path AS source_path,
                p.name          AS project_name
            FROM conversation_entries ce
            JOIN conversations c ON ce.conversation_id = c.id
            LEFT JOIN projects p ON c.project_id = p.id
            WHERE ${likeClauses}
            LIMIT ?
        `;

        rows = database.prepare(sql).all(...params, fetchLimit);
    } catch (err) {
        logger.warn('Transcript search query failed', { error: err.message });
        // Surface as a thrown error so unified search marks bm25 degraded.
        throw err;
    }

    const scored = [];
    for (const row of rows) {
        const lower = (row.content || '').toLowerCase();
        let tf = 0;
        let coverage = 0;
        for (const term of terms) {
            const c = countOccurrences(lower, term);
            if (c > 0) {
                coverage++;
                tf += c;
            }
        }
        if (coverage === 0) continue;

        // Coverage-weighted term frequency. All-terms-present rows rank above
        // single-term rows; a touch of log dampening on raw frequency.
        const score = coverage * 10 + Math.log1p(tf);

        scored.push({
            snippet: buildSnippet(row.content, terms),
            content: row.content,
            score,
            source_path: row.source_path || null,
            agent: 'claude_code',
            workspace: row.project_name || null,
            match_type: 'transcript_keyword',
            source_environment: 'cm-transcripts',
            created_at: row.timestamp || null,
            role: row.role || null,
        });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit);

    return {
        query,
        total_matches: scored.length,
        count: hits.length,
        hits,
        sources_queried: ['cm-transcripts'],
    };
}

export { search };

export default { search };
