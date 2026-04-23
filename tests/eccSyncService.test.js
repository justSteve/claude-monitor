import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { createEntityStore } from '../server/services/entityStoreService.js';
import { createEccSync } from '../server/services/eccSyncService.js';

const MIGRATION_PATH = path.join(
    import.meta.dir,
    '..',
    'server',
    'db',
    'migrations',
    '001-entity-store.sql',
);

const SEED_PATH = path.join(
    import.meta.dir,
    '..',
    'server',
    'data',
    'ecc-seed.json',
);

let db;
let store;

beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(migrationSql);
    store = createEntityStore(db);
});

afterEach(() => {
    db.close();
});

// ── syncAll with real seed data ────────────────────────────────────

describe('syncAll with real seed data', () => {
    it('creates entities for all zgents in the seed file', () => {
        const sync = createEccSync(store, SEED_PATH);
        const result = sync.syncAll();

        // Seed has 11 zgents + 1 person + 5 conventions + 4 tools + 1 enterprise concept = 22
        expect(result.entitiesCreated).toBe(22);
        expect(result.entitiesUpdated).toBe(0);

        // Spot-check specific zgents
        const coo = store.getEntityById('ecc-zgent-coo');
        expect(coo).not.toBeNull();
        expect(coo.name).toBe('COO');
        expect(coo.type).toBe('zgent');

        const dreader = store.getEntityById('ecc-zgent-dreader');
        expect(dreader).not.toBeNull();
        expect(dreader.name).toBe('DReader');

        const gasCity = store.getEntityById('ecc-zgent-gas-city');
        expect(gasCity).not.toBeNull();
        expect(gasCity.name).toBe('Gas City');
    });

    it('sets all ECC entities to source ecc and confidence 1.0', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const coo = store.getEntityById('ecc-zgent-coo');
        expect(coo.source).toBe('ecc');
        expect(coo.confidence).toBe(1.0);

        const steve = store.getEntityById('ecc-person-steve');
        expect(steve.source).toBe('ecc');
        expect(steve.confidence).toBe(1.0);

        const beads = store.getEntityById('ecc-convention-beads-first');
        expect(beads.source).toBe('ecc');
        expect(beads.confidence).toBe(1.0);
    });

    it('builds correct aliases for zgents', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const coo = store.getEntityById('ecc-zgent-coo');
        // COO has lowercase alias "coo" and prefix "co"
        expect(coo.aliases).toContain('coo');
        expect(coo.aliases).toContain('co');

        const gasCity = store.getEntityById('ecc-zgent-gas-city');
        // Gas City has lowercase alias and prefix "gc"
        expect(gasCity.aliases).toContain('gas city');
        expect(gasCity.aliases).toContain('gc');
    });

    it('creates tool entities with aliases', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const beadsTool = store.getEntityById('ecc-tool-beads');
        expect(beadsTool).not.toBeNull();
        expect(beadsTool.name).toBe('beads');
        expect(beadsTool.type).toBe('tool');
        expect(beadsTool.aliases).toContain('bd');

        const cass = store.getEntityById('ecc-tool-cass');
        expect(cass).not.toBeNull();
        expect(cass.aliases).toContain('cass');
    });

    it('creates people entities', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const steve = store.getEntityById('ecc-person-steve');
        expect(steve).not.toBeNull();
        expect(steve.name).toBe('Steve');
        expect(steve.type).toBe('person');
    });

    it('creates convention entities', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const beads = store.getEntityById('ecc-convention-beads-first');
        expect(beads).not.toBeNull();
        expect(beads.name).toBe('beads-first');
        expect(beads.type).toBe('convention');
    });

    it('creates relations based on tier', () => {
        const sync = createEccSync(store, SEED_PATH);
        const result = sync.syncAll();

        expect(result.relationsCreated).toBeGreaterThan(0);

        // Orchestrators get "owns" relation
        const cooRelations = store.getRelations('ecc-zgent-coo');
        const ownsEnterprise = cooRelations.find(
            r => r.from_entity_id === 'ecc-zgent-coo' &&
                 r.to_entity_id === 'ecc-concept-enterprise' &&
                 r.relation === 'owns'
        );
        expect(ownsEnterprise).not.toBeUndefined();

        // Service-providers get "serves" relation
        const drRelations = store.getRelations('ecc-zgent-dreader');
        const servesEnterprise = drRelations.find(
            r => r.from_entity_id === 'ecc-zgent-dreader' &&
                 r.to_entity_id === 'ecc-concept-enterprise' &&
                 r.relation === 'serves'
        );
        expect(servesEnterprise).not.toBeUndefined();

        // Consumers get "uses" relation
        const straderRelations = store.getRelations('ecc-zgent-strader');
        const usesEnterprise = straderRelations.find(
            r => r.from_entity_id === 'ecc-zgent-strader' &&
                 r.to_entity_id === 'ecc-concept-enterprise' &&
                 r.relation === 'uses'
        );
        expect(usesEnterprise).not.toBeUndefined();
    });
});

// ── idempotency ────────────────────────────────────────────────────

describe('idempotency', () => {
    it('second sync updates existing entities without duplicating', () => {
        const sync = createEccSync(store, SEED_PATH);

        const first = sync.syncAll();
        expect(first.entitiesCreated).toBe(22);
        expect(first.entitiesUpdated).toBe(0);

        const second = sync.syncAll();
        expect(second.entitiesCreated).toBe(0);
        expect(second.entitiesUpdated).toBe(22);
        // Relations already exist, so none created on second pass
        expect(second.relationsCreated).toBe(0);
    });

    it('entity data is consistent after multiple syncs', () => {
        const sync = createEccSync(store, SEED_PATH);

        sync.syncAll();
        const cooAfterFirst = store.getEntityById('ecc-zgent-coo');

        sync.syncAll();
        const cooAfterSecond = store.getEntityById('ecc-zgent-coo');

        expect(cooAfterSecond.name).toBe(cooAfterFirst.name);
        expect(cooAfterSecond.type).toBe(cooAfterFirst.type);
        expect(cooAfterSecond.confidence).toBe(cooAfterFirst.confidence);
    });
});

// ── missing data file ──────────────────────────────────────────────

describe('graceful handling of missing data', () => {
    it('returns zeros when seed file does not exist', () => {
        const sync = createEccSync(store, '/tmp/nonexistent-ecc-seed.json');
        const result = sync.syncAll();

        expect(result.entitiesCreated).toBe(0);
        expect(result.entitiesUpdated).toBe(0);
        expect(result.relationsCreated).toBe(0);
    });

    it('does not throw when seed file is missing', () => {
        const sync = createEccSync(store, '/tmp/nonexistent-ecc-seed.json');
        expect(() => sync.syncAll()).not.toThrow();
    });
});

// ── entity lookup by alias ─────────────────────────────────────────

describe('entity lookup via aliases after sync', () => {
    it('findEntityByAlias resolves prefix codes', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const result = store.findEntityByAlias('co');
        expect(result).not.toBeNull();
        expect(result.name).toBe('COO');
    });

    it('extractEntitiesFromQuery finds ECC entities', () => {
        const sync = createEccSync(store, SEED_PATH);
        sync.syncAll();

        const results = store.extractEntitiesFromQuery('How does COO interact with DReader?');
        const names = results.map(r => r.name).sort();
        expect(names).toContain('COO');
        expect(names).toContain('DReader');
    });
});
