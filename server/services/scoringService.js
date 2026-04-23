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
    fuseScores,
    contentHash,
    deduplicateResults,
};
