/**
 * Entity Store Service
 * Manages entity persistence, linking, boosting, and extraction for unified memory search.
 *
 * Uses raw bun:sqlite Database directly (not the db/index.js wrapper) for testability.
 * Factory function pattern: createEntityStore(db) returns the service API.
 *
 * Part of co-1pc: unified memory search.
 */

import logger from './logService.js';

/**
 * Create an entity store backed by the given bun:sqlite Database instance.
 *
 * @param {import('bun:sqlite').Database} db  Raw bun:sqlite database (must already have the entity tables)
 * @returns {object} Entity store API
 */
export function createEntityStore(db) {

    // ── prepared statements (lazy, cached) ──────────────────────────

    const stmts = {
        upsert: db.query(`
            INSERT INTO entities (id, name, type, source, confidence, aliases)
            VALUES ($id, $name, $type, $source, $confidence, $aliases)
            ON CONFLICT(id) DO UPDATE SET
                name       = excluded.name,
                type       = excluded.type,
                source     = excluded.source,
                confidence = excluded.confidence,
                aliases    = excluded.aliases
        `),

        getById: db.query(`SELECT * FROM entities WHERE id = ?`),

        getByName: db.query(`SELECT * FROM entities WHERE name = ?`),

        allEntities: db.query(`SELECT * FROM entities`),

        linkInsert: db.query(`
            INSERT INTO entity_links (entity_id, memory_id, memory_source)
            VALUES ($entityId, $memoryId, $memorySource)
        `),

        incrementCoOcc: db.query(`
            UPDATE entity_links
            SET co_occurrence = co_occurrence + 1,
                last_seen_at  = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE entity_id = $entityId AND memory_id = $memoryId
        `),

        getLinkedMemories: db.query(`
            SELECT * FROM entity_links WHERE entity_id = ?
        `),

        countLinks: db.query(`
            SELECT COUNT(*) AS cnt FROM entity_links WHERE entity_id = ?
        `),

        addRelation: db.query(`
            INSERT INTO entity_relations (from_entity_id, to_entity_id, relation, source, strength)
            VALUES ($fromId, $toId, $relation, $source, $strength)
        `),

        getRelations: db.query(`
            SELECT * FROM entity_relations
            WHERE from_entity_id = ? OR to_entity_id = ?
        `),
    };

    // ── helpers ──────────────────────────────────────────────────────

    /** Parse the aliases JSON column, returning an array (empty on failure). */
    function parseAliases(row) {
        if (!row) return null;
        try {
            return { ...row, aliases: JSON.parse(row.aliases || '[]') };
        } catch {
            logger.warn(`Failed to parse aliases JSON for entity ${row.id}`);
            return { ...row, aliases: [] };
        }
    }

    // ── public API ──────────────────────────────────────────────────

    /**
     * Insert or update an entity.
     */
    function upsertEntity({ id, name, type, source, confidence = 0.5, aliases = [] }) {
        if (!id || !name || !type || !source) {
            throw new Error('upsertEntity requires id, name, type, source');
        }
        const aliasesJson = JSON.stringify(aliases);
        stmts.upsert.run({
            $id: id,
            $name: name,
            $type: type,
            $source: source,
            $confidence: confidence,
            $aliases: aliasesJson,
        });
        logger.debug(`Entity upserted: ${id} (${name})`);
    }

    /**
     * Retrieve an entity by primary key.
     */
    function getEntityById(id) {
        const row = stmts.getById.get(id);
        return parseAliases(row);
    }

    /**
     * Retrieve an entity by unique name.
     */
    function getEntityByName(name) {
        const row = stmts.getByName.get(name);
        return parseAliases(row);
    }

    /**
     * Find an entity whose aliases array contains the given string (case-insensitive).
     * Linear scan over all entities -- fine for the expected cardinality (hundreds, not millions).
     */
    function findEntityByAlias(alias) {
        const needle = alias.toLowerCase();
        const all = stmts.allEntities.all();
        for (const row of all) {
            let aliases;
            try {
                aliases = JSON.parse(row.aliases || '[]');
            } catch {
                continue;
            }
            if (aliases.some(a => a.toLowerCase() === needle)) {
                return parseAliases(row);
            }
        }
        return null;
    }

    /**
     * Record a link between an entity and a memory (transcript or mempalace).
     */
    function linkEntityToMemory(entityId, memoryId, memorySource) {
        stmts.linkInsert.run({
            $entityId: entityId,
            $memoryId: memoryId,
            $memorySource: memorySource,
        });
        logger.debug(`Linked entity ${entityId} -> memory ${memoryId} (${memorySource})`);
    }

    /**
     * Increment the co-occurrence counter for an existing entity-memory link.
     */
    function incrementCoOccurrence(entityId, memoryId) {
        stmts.incrementCoOcc.run({
            $entityId: entityId,
            $memoryId: memoryId,
        });
    }

    /**
     * Return all entity_links rows for the given entity.
     */
    function getLinkedMemories(entityId) {
        return stmts.getLinkedMemories.all(entityId);
    }

    /**
     * Compute a relevance boost score for an entity.
     *
     * Formula:  confidence * (1 / (1 + 0.001 * (linkCount - 1)^2))
     *
     * This attenuates "hub" entities that link to everything -- their boost
     * approaches zero as linkCount grows, so they don't dominate search results.
     */
    function computeEntityBoost(entityId) {
        const entity = getEntityById(entityId);
        if (!entity) return 0;

        const { cnt } = stmts.countLinks.get(entityId);
        const linkCount = cnt || 0;
        const attenuation = 1 / (1 + 0.001 * Math.pow(linkCount - 1, 2));
        return entity.confidence * attenuation;
    }

    /**
     * Insert a relation between two entities.
     */
    function addRelation(fromId, toId, relation, source, strength = 0.5) {
        stmts.addRelation.run({
            $fromId: fromId,
            $toId: toId,
            $relation: relation,
            $source: source,
            $strength: strength,
        });
        logger.debug(`Relation added: ${fromId} -[${relation}]-> ${toId}`);
    }

    /**
     * Return all relations involving the given entity (as source or target).
     */
    function getRelations(entityId) {
        return stmts.getRelations.all(entityId, entityId);
    }

    /**
     * Extract known entities from a free-text query.
     *
     * Tokenizes the query and matches tokens (and bigrams) against entity names
     * and aliases (case-insensitive).  Returns an array of matched entity objects
     * with their parsed aliases.
     */
    function extractEntitiesFromQuery(query) {
        if (!query || typeof query !== 'string') return [];

        const all = stmts.allEntities.all();
        const lowerQuery = query.toLowerCase();

        const matched = [];
        const seenIds = new Set();

        for (const row of all) {
            const nameLower = row.name.toLowerCase();
            let aliases;
            try {
                aliases = JSON.parse(row.aliases || '[]');
            } catch {
                aliases = [];
            }

            // Check if the entity name appears in the query
            if (lowerQuery.includes(nameLower)) {
                if (!seenIds.has(row.id)) {
                    seenIds.add(row.id);
                    matched.push(parseAliases(row));
                }
                continue;
            }

            // Check if any alias appears in the query
            for (const alias of aliases) {
                if (lowerQuery.includes(alias.toLowerCase())) {
                    if (!seenIds.has(row.id)) {
                        seenIds.add(row.id);
                        matched.push(parseAliases(row));
                    }
                    break;
                }
            }
        }

        return matched;
    }

    return {
        upsertEntity,
        getEntityById,
        getEntityByName,
        findEntityByAlias,
        linkEntityToMemory,
        incrementCoOccurrence,
        getLinkedMemories,
        computeEntityBoost,
        addRelation,
        getRelations,
        extractEntitiesFromQuery,
    };
}

export default createEntityStore;
