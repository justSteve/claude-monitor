/**
 * Proposals route for promotion review.
 * Part of co-1pc: unified memory search — Phase 5.
 */
import express from 'express';

/**
 * Create the proposals router with an injected promotion service.
 *
 * @param {object} promotionService - The promotion service (from createPromotionService)
 * @returns {express.Router}
 */
export function createProposalsRouter(promotionService) {
    const router = express.Router();

    /**
     * GET /api/v1/proposals
     * List pending proposals. Optional ?status= filter.
     */
    router.get('/', (req, res) => {
        try {
            const status = req.query.status || 'proposed';
            const proposals = promotionService.getProposals(status);
            res.json(proposals);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * GET /api/v1/proposals/:id
     * Get a specific proposal by ID.
     */
    router.get('/:id', (req, res) => {
        try {
            const proposal = promotionService.getProposal(req.params.id);
            if (!proposal) {
                return res.status(404).json({ error: 'Proposal not found' });
            }
            res.json(proposal);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/v1/proposals/:id/accept
     * Accept a proposal. Optional body: { edit: "edited rule text" }
     */
    router.post('/:id/accept', (req, res) => {
        try {
            const { edit } = req.body || {};
            const result = promotionService.acceptProposal(req.params.id, edit);

            if (!result.success) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            res.json({ success: true, proposal: result.proposal });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/v1/proposals/:id/dismiss
     * Dismiss a proposal — won't be proposed again.
     */
    router.post('/:id/dismiss', (req, res) => {
        try {
            const result = promotionService.dismissProposal(req.params.id);

            if (!result.success) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
