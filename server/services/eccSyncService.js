/**
 * ECC Sync Service
 * Syncs enterprise entity data from a seed JSON file (or future ECC data directory)
 * into the entity store for unified memory search.
 *
 * Factory function pattern: createEccSync(entityStore, dataPath) returns the service API.
 *
 * Part of co-1pc: unified memory search.
 */

import fs from 'fs';
import path from 'path';
import logger from './logService.js';

/**
 * Normalize a name into a deterministic entity ID segment.
 * Lowercase, replace non-alphanumeric with hyphens, collapse runs.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Build an aliases array for a zgent entry.
 * Includes: lowercase name, prefix (if present), repo short name (if present).
 *
 * @param {object} zgent  Zgent entry from the seed data
 * @returns {string[]}
 */
function buildZgentAliases(zgent) {
    const aliases = [];
    const lowerName = zgent.name.toLowerCase();

    // Add lowercase name if it differs from the canonical name
    if (lowerName !== zgent.name) {
        aliases.push(lowerName);
    }

    // Add prefix code as alias
    if (zgent.prefix) {
        aliases.push(zgent.prefix);
    }

    // Add repo short name as alias (e.g. "justSteve/COO" -> "COO" repo name)
    if (zgent.repo) {
        const repoShort = zgent.repo.split('/').pop();
        const repoLower = repoShort.toLowerCase();
        if (repoShort !== zgent.name && !aliases.includes(repoLower)) {
            aliases.push(repoShort);
            if (repoLower !== repoShort) {
                aliases.push(repoLower);
            }
        }
    }

    return aliases;
}

/**
 * Build an aliases array for a tool entry.
 *
 * @param {object} tool  Tool entry from the seed data
 * @returns {string[]}
 */
function buildToolAliases(tool) {
    const aliases = [];
    const lowerName = tool.name.toLowerCase();

    if (lowerName !== tool.name) {
        aliases.push(lowerName);
    }

    if (tool.aliases) {
        for (const alias of tool.aliases) {
            if (!aliases.includes(alias)) {
                aliases.push(alias);
            }
        }
    }

    return aliases;
}

/**
 * Create an ECC sync service backed by the given entity store.
 *
 * @param {object} entityStore  Entity store from createEntityStore(db)
 * @param {string} dataPath     Path to the seed JSON file or ECC data directory
 * @returns {object} ECC sync API
 */
export function createEccSync(entityStore, dataPath) {

    /**
     * Load the seed data from the configured path.
     * Supports a single JSON file or a directory containing ecc-*.json files.
     *
     * @returns {object|null}  Parsed seed data, or null if unavailable
     */
    function loadSeedData() {
        try {
            const stat = fs.statSync(dataPath);

            if (stat.isFile()) {
                const raw = fs.readFileSync(dataPath, 'utf8');
                return JSON.parse(raw);
            }

            if (stat.isDirectory()) {
                // Future: merge ecc-*.json files from a directory
                // For now, look for ecc-seed.json inside the directory
                const seedFile = path.join(dataPath, 'ecc-seed.json');
                if (fs.existsSync(seedFile)) {
                    const raw = fs.readFileSync(seedFile, 'utf8');
                    return JSON.parse(raw);
                }
                logger.warn(`ECC data directory exists but no ecc-seed.json found: ${dataPath}`);
                return null;
            }

            logger.warn(`ECC data path is neither file nor directory: ${dataPath}`);
            return null;
        } catch (err) {
            if (err.code === 'ENOENT') {
                logger.warn(`ECC seed data not found at ${dataPath} — skipping sync`);
                return null;
            }
            logger.error(`Failed to load ECC seed data from ${dataPath}: ${err.message}`);
            return null;
        }
    }

    /**
     * Sync all entity types from the seed data into the entity store.
     * Idempotent: safe to call repeatedly; updates existing entities.
     *
     * @returns {{ entitiesCreated: number, entitiesUpdated: number, relationsCreated: number }}
     */
    function syncAll() {
        const data = loadSeedData();
        if (!data) {
            logger.info('ECC sync: no data loaded, returning zeros');
            return { entitiesCreated: 0, entitiesUpdated: 0, relationsCreated: 0 };
        }

        let entitiesCreated = 0;
        let entitiesUpdated = 0;
        let relationsCreated = 0;

        // Track which entity IDs we've synced for relation building
        const syncedZgentIds = [];

        // ── Zgents ──────────────────────────────────────────────────
        if (data.zgents && Array.isArray(data.zgents)) {
            for (const zgent of data.zgents) {
                const id = `ecc-zgent-${normalizeName(zgent.name)}`;
                const existing = entityStore.getEntityById(id);

                entityStore.upsertEntity({
                    id,
                    name: zgent.name,
                    type: 'zgent',
                    source: 'ecc',
                    confidence: 1.0,
                    aliases: buildZgentAliases(zgent),
                });

                if (existing) {
                    entitiesUpdated++;
                } else {
                    entitiesCreated++;
                }

                syncedZgentIds.push({ id, tier: zgent.tier });
            }
        }

        // ── People ──────────────────────────────────────────────────
        if (data.people && Array.isArray(data.people)) {
            for (const person of data.people) {
                const id = `ecc-person-${normalizeName(person.name)}`;
                const existing = entityStore.getEntityById(id);

                const aliases = [];
                const lowerName = person.name.toLowerCase();
                if (lowerName !== person.name) {
                    aliases.push(lowerName);
                }

                entityStore.upsertEntity({
                    id,
                    name: person.name,
                    type: 'person',
                    source: 'ecc',
                    confidence: 1.0,
                    aliases,
                });

                if (existing) {
                    entitiesUpdated++;
                } else {
                    entitiesCreated++;
                }
            }
        }

        // ── Conventions ─────────────────────────────────────────────
        if (data.conventions && Array.isArray(data.conventions)) {
            for (const conv of data.conventions) {
                const id = `ecc-convention-${normalizeName(conv.name)}`;
                const existing = entityStore.getEntityById(id);

                entityStore.upsertEntity({
                    id,
                    name: conv.name,
                    type: 'convention',
                    source: 'ecc',
                    confidence: 1.0,
                    aliases: [],
                });

                if (existing) {
                    entitiesUpdated++;
                } else {
                    entitiesCreated++;
                }
            }
        }

        // ── Tools ───────────────────────────────────────────────────
        if (data.tools && Array.isArray(data.tools)) {
            for (const tool of data.tools) {
                const id = `ecc-tool-${normalizeName(tool.name)}`;
                const existing = entityStore.getEntityById(id);

                entityStore.upsertEntity({
                    id,
                    name: tool.name,
                    type: 'tool',
                    source: 'ecc',
                    confidence: 1.0,
                    aliases: buildToolAliases(tool),
                });

                if (existing) {
                    entitiesUpdated++;
                } else {
                    entitiesCreated++;
                }
            }
        }

        // ── Relations ───────────────────────────────────────────────
        // Create an "enterprise" concept entity to anchor relations
        const enterpriseId = 'ecc-concept-enterprise';
        const existingEnterprise = entityStore.getEntityById(enterpriseId);

        entityStore.upsertEntity({
            id: enterpriseId,
            name: 'Enterprise',
            type: 'concept',
            source: 'ecc',
            confidence: 1.0,
            aliases: ['zgent enterprise', 'the enterprise'],
        });

        if (!existingEnterprise) {
            entitiesCreated++;
        } else {
            entitiesUpdated++;
        }

        // Build tier-based relations
        for (const { id, tier } of syncedZgentIds) {
            const existingRelations = entityStore.getRelations(id);

            // Check if a relation to enterprise already exists
            const hasEnterpriseRelation = existingRelations.some(
                r => (r.from_entity_id === id && r.to_entity_id === enterpriseId) ||
                     (r.from_entity_id === enterpriseId && r.to_entity_id === id)
            );

            if (!hasEnterpriseRelation) {
                if (tier === 'orchestrator') {
                    entityStore.addRelation(id, enterpriseId, 'owns', 'ecc', 0.9);
                    relationsCreated++;
                } else if (tier === 'service-provider') {
                    entityStore.addRelation(id, enterpriseId, 'serves', 'ecc', 0.8);
                    relationsCreated++;
                } else if (tier === 'consumer' || tier === 'restricted') {
                    entityStore.addRelation(id, enterpriseId, 'uses', 'ecc', 0.6);
                    relationsCreated++;
                }
            }
        }

        logger.info(
            `ECC sync complete: ${entitiesCreated} created, ${entitiesUpdated} updated, ${relationsCreated} relations`
        );

        return { entitiesCreated, entitiesUpdated, relationsCreated };
    }

    return {
        syncAll,
        loadSeedData,
    };
}

export default createEccSync;
