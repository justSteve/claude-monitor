/**
 * Shared keyword-search primitives (co-ceyz3.1)
 *
 * Extracted verbatim from transcriptSearchService.js so the curated-corpus
 * backend scores text the same way the transcript backend does. Pure functions,
 * no I/O. If you change scoring behavior here, you change it for every
 * keyword-style retriever at once — that is the point.
 */

// Snippet window (chars) returned around the match for display.
export const SNIPPET_MAX_CHARS = 400;

/**
 * Split a free-text query into distinct, non-trivial keyword terms.
 * Keeps tokens of length >= 2; lowercased; deduplicated.
 * @param {string} queryText
 * @returns {string[]}
 */
export function tokenize(queryText) {
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
 * Build a snippet around the first occurrence of any term.
 * @param {string} content
 * @param {string[]} terms
 * @returns {string}
 */
export function buildSnippet(content, terms) {
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
 * Count occurrences of a term in content (case-insensitive input expected).
 * @param {string} lowerContent
 * @param {string} term
 * @returns {number}
 */
export function countOccurrences(lowerContent, term) {
    let count = 0;
    let idx = lowerContent.indexOf(term);
    while (idx !== -1) {
        count++;
        idx = lowerContent.indexOf(term, idx + term.length);
    }
    return count;
}

/**
 * Coverage-weighted term-frequency score, shared by keyword retrievers.
 * All-terms-present rows rank above single-term rows; log dampening on raw
 * frequency. Absolute scale is not load-bearing — unified search re-normalizes
 * and fuses by rank (see scoringService fuseRankedLists / co-n7mx).
 * @param {string} content
 * @param {string[]} terms
 * @returns {number} 0 if no term matches
 */
export function coverageTfScore(content, terms) {
    const lower = (content || '').toLowerCase();
    let tf = 0;
    let coverage = 0;
    for (const term of terms) {
        const c = countOccurrences(lower, term);
        if (c > 0) {
            coverage++;
            tf += c;
        }
    }
    if (coverage === 0) return 0;
    return coverage * 10 + Math.log1p(tf);
}

export default { SNIPPET_MAX_CHARS, tokenize, buildSnippet, countOccurrences, coverageTfScore };
