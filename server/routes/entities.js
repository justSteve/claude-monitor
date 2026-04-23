/**
 * Entity lookup route for unified memory search.
 * Part of co-1pc.
 */
import express from 'express';

export function createEntitiesRouter(entityStore) {
    const router = express.Router();

    /**
     * GET /api/v1/entities/:name
     * Look up an entity by name or alias, returning entity data,
     * relations, linked memory count, and computed boost score.
     */
    router.get('/:name', (req, res) => {
        try {
            const entity = entityStore.getEntityByName(req.params.name)
                || entityStore.findEntityByAlias(req.params.name);

            if (!entity) {
                return res.status(404).json({ error: 'Entity not found' });
            }

            const relations = entityStore.getRelations(entity.id);
            const links = entityStore.getLinkedMemories(entity.id);
            const boost = entityStore.computeEntityBoost(entity.id);

            res.json({ entity, relations, linked_memories: links.length, boost });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
