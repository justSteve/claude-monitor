import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

// The service imports logService which has side-effects. Mock it by
// intercepting the import with a stub that doesn't touch the filesystem.
// We can't easily mock ESM imports in bun, so we'll rely on the service
// gracefully handling a missing logger (it uses logger.debug/warn which
// are no-ops if logService initializes without a config).
// Instead, we'll import the factory directly.
import { createEntityStore } from '../server/services/entityStoreService.js';

const MIGRATION_PATH = path.join(
    import.meta.dir,
    '..',
    'server',
    'db',
    'migrations',
    '001-entity-store.sql',
);

let db;
let store;

beforeEach(() => {
    db = new Database(':memory:');
    // Enable foreign keys
    db.exec('PRAGMA foreign_keys = ON');
    // Apply the entity store migration
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(migrationSql);
    store = createEntityStore(db);
});

afterEach(() => {
    db.close();
});

// ── helpers ─────────────────────────────────────────────────────────

function seedEntity(overrides = {}) {
    const defaults = {
        id: 'ent-coo',
        name: 'COO',
        type: 'zgent',
        source: 'ecc',
        confidence: 0.9,
        aliases: ['Chief Operating Officer', 'coo-agent'],
    };
    store.upsertEntity({ ...defaults, ...overrides });
    return { ...defaults, ...overrides };
}

// ── upsert & retrieve ───────────────────────────────────────────────

describe('upsertEntity / getEntityByName', () => {
    it('inserts an entity and retrieves it by name', () => {
        seedEntity();
        const entity = store.getEntityByName('COO');

        expect(entity).not.toBeNull();
        expect(entity.id).toBe('ent-coo');
        expect(entity.name).toBe('COO');
        expect(entity.type).toBe('zgent');
        expect(entity.source).toBe('ecc');
        expect(entity.confidence).toBe(0.9);
        expect(entity.aliases).toEqual(['Chief Operating Officer', 'coo-agent']);
    });

    it('retrieves an entity by id', () => {
        seedEntity();
        const entity = store.getEntityById('ent-coo');
        expect(entity).not.toBeNull();
        expect(entity.name).toBe('COO');
    });

    it('updates an existing entity on conflict', () => {
        seedEntity();
        store.upsertEntity({
            id: 'ent-coo',
            name: 'COO',
            type: 'zgent',
            source: 'ecc',
            confidence: 0.95,
            aliases: ['Chief Operating Officer'],
        });
        const entity = store.getEntityById('ent-coo');
        expect(entity.confidence).toBe(0.95);
        expect(entity.aliases).toEqual(['Chief Operating Officer']);
    });

    it('returns null for a non-existent entity', () => {
        expect(store.getEntityByName('nope')).toBeNull();
        expect(store.getEntityById('nope')).toBeNull();
    });
});

// ── alias lookup ────────────────────────────────────────────────────

describe('findEntityByAlias', () => {
    it('finds an entity by alias (case-insensitive)', () => {
        seedEntity();
        const entity = store.findEntityByAlias('chief operating officer');
        expect(entity).not.toBeNull();
        expect(entity.id).toBe('ent-coo');
    });

    it('matches alias with different casing', () => {
        seedEntity();
        const entity = store.findEntityByAlias('COO-AGENT');
        expect(entity).not.toBeNull();
        expect(entity.id).toBe('ent-coo');
    });

    it('returns null when alias does not match', () => {
        seedEntity();
        expect(store.findEntityByAlias('nonexistent-alias')).toBeNull();
    });
});

// ── entity-memory linking & boost ───────────────────────────────────

describe('linkEntityToMemory / computeEntityBoost', () => {
    it('links an entity to a memory and computes boost', () => {
        seedEntity();
        store.linkEntityToMemory('ent-coo', 'mem-001', 'transcript');

        const links = store.getLinkedMemories('ent-coo');
        expect(links).toHaveLength(1);
        expect(links[0].entity_id).toBe('ent-coo');
        expect(links[0].memory_id).toBe('mem-001');
        expect(links[0].memory_source).toBe('transcript');
        expect(links[0].co_occurrence).toBe(1);
    });

    it('computes boost close to confidence for a single link', () => {
        seedEntity({ confidence: 0.9 });
        store.linkEntityToMemory('ent-coo', 'mem-001', 'transcript');

        const boost = store.computeEntityBoost('ent-coo');
        // With 1 link: attenuation = 1/(1 + 0.001*(1-1)^2) = 1/(1+0) = 1.0
        // boost = 0.9 * 1.0 = 0.9
        expect(boost).toBe(0.9);
    });

    it('increments co-occurrence', () => {
        seedEntity();
        store.linkEntityToMemory('ent-coo', 'mem-001', 'transcript');
        store.incrementCoOccurrence('ent-coo', 'mem-001');
        store.incrementCoOccurrence('ent-coo', 'mem-001');

        const links = store.getLinkedMemories('ent-coo');
        expect(links[0].co_occurrence).toBe(3);
    });

    it('returns 0 boost for a non-existent entity', () => {
        expect(store.computeEntityBoost('nope')).toBe(0);
    });
});

// ── hub attenuation ─────────────────────────────────────────────────

describe('hub entity attenuation', () => {
    it('entity with 500 links should have boost < 0.01', () => {
        seedEntity({ confidence: 0.9 });

        // Insert 500 links
        const insertLink = db.query(`
            INSERT INTO entity_links (entity_id, memory_id, memory_source)
            VALUES ($entityId, $memoryId, $memorySource)
        `);
        for (let i = 0; i < 500; i++) {
            insertLink.run({
                $entityId: 'ent-coo',
                $memoryId: `mem-${String(i).padStart(4, '0')}`,
                $memorySource: 'transcript',
            });
        }

        const boost = store.computeEntityBoost('ent-coo');
        // With 500 links: attenuation = 1/(1 + 0.001*(499)^2) = 1/(1+249.001) ≈ 0.004
        // boost = 0.9 * 0.004 ≈ 0.0036
        expect(boost).toBeLessThan(0.01);
    });
});

// ── linked memory IDs ───────────────────────────────────────────────

describe('getLinkedMemories', () => {
    it('returns all linked memory rows for an entity', () => {
        seedEntity();
        store.linkEntityToMemory('ent-coo', 'mem-001', 'transcript');
        store.linkEntityToMemory('ent-coo', 'mem-002', 'mempalace');
        store.linkEntityToMemory('ent-coo', 'mem-003', 'transcript');

        const links = store.getLinkedMemories('ent-coo');
        expect(links).toHaveLength(3);

        const memoryIds = links.map(l => l.memory_id).sort();
        expect(memoryIds).toEqual(['mem-001', 'mem-002', 'mem-003']);
    });

    it('returns empty array for entity with no links', () => {
        seedEntity();
        expect(store.getLinkedMemories('ent-coo')).toEqual([]);
    });
});

// ── relations ───────────────────────────────────────────────────────

describe('addRelation / getRelations', () => {
    it('adds and retrieves a relation between two entities', () => {
        seedEntity({ id: 'ent-coo', name: 'COO' });
        seedEntity({ id: 'ent-dreader', name: 'DReader', aliases: [] });

        store.addRelation('ent-coo', 'ent-dreader', 'serves', 'ecc', 0.8);

        const relations = store.getRelations('ent-coo');
        expect(relations).toHaveLength(1);
        expect(relations[0].from_entity_id).toBe('ent-coo');
        expect(relations[0].to_entity_id).toBe('ent-dreader');
        expect(relations[0].relation).toBe('serves');
        expect(relations[0].source).toBe('ecc');
        expect(relations[0].strength).toBe(0.8);
    });

    it('retrieves relations where entity is the target', () => {
        seedEntity({ id: 'ent-coo', name: 'COO' });
        seedEntity({ id: 'ent-dreader', name: 'DReader', aliases: [] });

        store.addRelation('ent-dreader', 'ent-coo', 'uses', 'inferred', 0.6);

        const relations = store.getRelations('ent-coo');
        expect(relations).toHaveLength(1);
        expect(relations[0].from_entity_id).toBe('ent-dreader');
        expect(relations[0].to_entity_id).toBe('ent-coo');
    });

    it('returns empty array for entity with no relations', () => {
        seedEntity();
        expect(store.getRelations('ent-coo')).toEqual([]);
    });
});

// ── query extraction ────────────────────────────────────────────────

describe('extractEntitiesFromQuery', () => {
    it('matches entity by name in query string', () => {
        seedEntity({ id: 'ent-coo', name: 'COO' });
        seedEntity({ id: 'ent-dreader', name: 'DReader', aliases: ['dreader'] });

        const results = store.extractEntitiesFromQuery('What does COO manage?');
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('ent-coo');
    });

    it('matches entity by alias in query string', () => {
        seedEntity({ id: 'ent-coo', name: 'COO', aliases: ['Chief Operating Officer'] });

        const results = store.extractEntitiesFromQuery(
            'Tell me about the Chief Operating Officer',
        );
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('ent-coo');
    });

    it('matches multiple entities in a single query', () => {
        seedEntity({ id: 'ent-coo', name: 'COO' });
        seedEntity({ id: 'ent-dreader', name: 'DReader', aliases: [] });

        const results = store.extractEntitiesFromQuery('How do COO and DReader interact?');
        expect(results).toHaveLength(2);
        const ids = results.map(r => r.id).sort();
        expect(ids).toEqual(['ent-coo', 'ent-dreader']);
    });

    it('returns empty array for empty or null query', () => {
        expect(store.extractEntitiesFromQuery('')).toEqual([]);
        expect(store.extractEntitiesFromQuery(null)).toEqual([]);
    });

    it('is case-insensitive', () => {
        seedEntity({ id: 'ent-coo', name: 'COO' });

        const results = store.extractEntitiesFromQuery('tell me about coo');
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('ent-coo');
    });
});
