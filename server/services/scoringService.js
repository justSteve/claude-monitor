const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const { join } = require('path');

let _configCache = null;

/**
 * Read and cache the unified-search configuration.
 * @returns {Object} The parsed config from unified-search.json
 */
function getConfig() {
    if (!_configCache) {
        const configPath = join(__dirname, '..', 'config', 'unified-search.json');
        _configCache = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    return _configCache;
}

/**
 * Normalize a raw BM25 score to 0-1 range via sigmoid.
 * @param {number} rawScore - The raw BM25 score
 * @returns {number} Normalized score between 0 and 1
 */
function normalizeBM25(rawScore) {
    return 1 / (1 + Math.exp(-rawScore / 5));
}

/**
 * Fuse multiple search signals into a single score using weighted sum.
 * Automatically re-normalizes weights when signals are null (timed out / unavailable).
 * @param {Object} signals - { bm25: number|null, semantic: number|null, entity: number|null }
 * @param {Object} weights - { bm25: number, semantic: number, entity: number }
 * @returns {number} Fused score between 0 and 1
 */
function fuseScores(signals, weights) {
    let weightSum = 0;
    let scoreSum = 0;

    for (const key of Object.keys(weights)) {
        if (signals[key] != null) {
            weightSum += weights[key];
            scoreSum += weights[key] * signals[key];
        }
    }

    if (weightSum === 0) return 0;
    return scoreSum / weightSum;
}

// ── Reciprocal Rank Fusion ───────────────────────────────────────────────────
//
// WHY THIS EXISTS: fuseScores() above compares raw scores from different
// retrievers, and those scores are not on comparable scales. normalizeBM25 is a
// sigmoid that saturates near 1.0, while cosine similarity for genuinely
// relevant prose sits at 0.4-0.6 and rarely passes 0.7. Because BM25 and
// semantic candidates come from different corpora, each carries only its own
// signal — so a keyword hit scored ~0.99 against a semantic hit's ~0.56 and won
// every time, regardless of relevance. Measured 2026-07-20: the first semantic
// result landed past rank 20 with a default limit of 10, i.e. never visible.
//
// RRF sidesteps calibration entirely by scoring position rather than magnitude:
// a document's contribution from each list is 1/(k + rank). It needs no tuning,
// is robust to one retriever's scores being wildly differently distributed, and
// rewards documents that BOTH retrievers liked. k dampens the advantage of the
// very top ranks; 60 is the standard value from the original TREC work.
//
// Entity is deliberately NOT a third list. It is not a retriever — it never
// produces candidates, it only boosts ones already found. Treating it as a
// ranked list would let it invent rankings from a signal that cannot retrieve.
// It is applied as a multiplier after fusion. co-n7mx.

const DEFAULT_RRF_K = 60;

/**
 * Sort a candidate list by its own raw score and stamp 1-based ranks.
 * Ranking is per-list, which is the whole point: ranks are comparable across
 * retrievers even when scores are not.
 * @param {Array} candidates - Objects carrying a numeric rawScore
 * @returns {Array} Same objects, ordered, each with `rank`
 */
function assignRanks(candidates) {
    return [...(candidates || [])]
        .sort((a, b) => (b.rawScore || 0) - (a.rawScore || 0))
        .map((c, i) => ({ ...c, rank: i + 1 }));
}

/**
 * Reciprocal-rank contribution across the lists a document appeared in.
 * @param {Object} ranks - { bm25?: number, semantic?: number } 1-based ranks
 * @param {Object} weights - Per-signal weights
 * @param {number} [k=60] - Rank damping constant
 * @returns {number} Fused score (unbounded above 0; only ordering is meaningful)
 */
function rrfScore(ranks, weights, k = DEFAULT_RRF_K) {
    let score = 0;
    for (const [signal, rank] of Object.entries(ranks || {})) {
        if (rank == null || !Number.isFinite(rank)) continue;
        score += (weights[signal] ?? 0) / (k + rank);
    }
    return score;
}

/**
 * Fuse several ranked candidate lists into one ordered, deduplicated result set.
 *
 * A document found by two retrievers accumulates both contributions, which is
 * how RRF rewards agreement without needing the two scales to agree.
 *
 * @param {Object} opts
 * @param {Object} opts.lists - { bm25: Array, semantic: Array } of candidates
 * @param {Object} opts.weights - Per-signal weights
 * @param {number} [opts.k=60] - Rank damping constant
 * @param {Function} [opts.entityBoostFor] - (content) => 0-1 boost, applied as
 *        a multiplier after fusion. Omit to skip entity boosting.
 * @param {number} [opts.entityWeight=0] - How strongly the boost multiplies
 * @returns {Array} Results sorted by fused score, each carrying signals/ranks
 */
function fuseRankedLists({ lists, weights, k = DEFAULT_RRF_K, entityBoostFor, entityWeight = 0 }) {
    const groups = new Map();

    // Signal keys mirror the retriever lists actually fused (plus entity,
    // which is a boost, not a retriever), so adding a retriever list — e.g.
    // `curated` (co-ceyz3.1) — needs no template edit here.
    const signalKeys = [...Object.keys(lists || {}), 'entity'];

    for (const [signal, rawList] of Object.entries(lists || {})) {
        for (const cand of assignRanks(rawList)) {
            const hash = contentHash(cand.content || '');
            if (!groups.has(hash)) {
                groups.set(hash, {
                    content: cand.content,
                    source: cand.source,
                    additional_sources: [],
                    signals: Object.fromEntries(signalKeys.map(key => [key, null])),
                    ranks: {},
                });
            }
            const g = groups.get(hash);
            // First list to claim a hash owns the primary source; later lists
            // are recorded as corroborating provenance rather than discarded.
            if (g.source && cand.source && g.source !== cand.source && g.ranks[signal] == null) {
                if (Object.keys(g.ranks).length > 0) g.additional_sources.push(cand.source);
            }
            g.ranks[signal] = cand.rank;
            g.signals[signal] = cand.rawScore ?? null;
        }
    }

    const results = [];
    for (const g of groups.values()) {
        let score = rrfScore(g.ranks, weights, k);
        if (entityBoostFor && entityWeight > 0) {
            const boost = entityBoostFor(g.content) || 0;
            g.signals.entity = boost;
            score *= 1 + entityWeight * boost;
        }
        g.score = score;
        results.push(g);
    }

    return results.sort((a, b) => b.score - a.score);
}

/**
 * Produce a content hash for deduplication purposes.
 * Case-insensitive, whitespace-normalized, uses first 500 chars.
 * @param {string} content - The content string to hash
 * @returns {string} Hex SHA-256 hash
 */
function contentHash(content) {
    const normalized = content
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
    return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Deduplicate search results by content hash.
 * Groups duplicates, keeps the highest-scoring result, folds lower-scored
 * sources into an `additional_sources` array. Returns results sorted
 * descending by score.
 * @param {Array} results - Array of { content, score, source, ... }
 * @returns {Array} Deduplicated and sorted results
 */
function deduplicateResults(results) {
    const groups = new Map();

    for (const result of results) {
        const hash = contentHash(result.content);

        if (!groups.has(hash)) {
            groups.set(hash, { ...result, additional_sources: [] });
        } else {
            const existing = groups.get(hash);
            if (result.score > existing.score) {
                // New result has higher score — it becomes the primary
                existing.additional_sources.push(existing.source);
                existing.source = result.source;
                existing.score = result.score;
                existing.content = result.content;
            } else {
                // Existing is higher — fold new source in
                existing.additional_sources.push(result.source);
            }
        }
    }

    return Array.from(groups.values()).sort((a, b) => b.score - a.score);
}

module.exports = {
    getConfig,
    normalizeBM25,
    fuseScores,        // legacy weighted-sum fusion; superseded by fuseRankedLists
    contentHash,
    deduplicateResults,
    assignRanks,
    rrfScore,
    fuseRankedLists,
    DEFAULT_RRF_K,
};
