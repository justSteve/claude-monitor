/**
 * MCP Server for Claude Monitor — unified memory search.
 *
 * Runs in the same process as the Express HTTP server.
 * Uses stdio transport for Claude Desktop / Claude Code / Cowork connections.
 * Enabled via MCP_ENABLED=true env var or --mcp CLI flag.
 *
 * Part of co-1pc: unified memory search — Phase 3.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import logger from '../services/logService.js';

/**
 * Create and configure the MCP server with all memory tools.
 *
 * @param {object} deps - Service dependencies
 * @param {object} deps.unifiedSearch - Unified search service
 * @param {object} deps.entityStore   - Entity store service
 * @param {object} deps.db            - Raw bun:sqlite Database
 * @returns {McpServer} Configured MCP server (not yet connected)
 */
export function createMcpServer({ unifiedSearch, entityStore, db }) {
    const server = new McpServer({
        name: 'claude-monitor-memory',
        version: '1.0.0',
    });

    registerTools(server, { unifiedSearch, entityStore, db, logger });

    logger.info('MCP server created with memory tools');

    return server;
}

/**
 * Start the MCP server with stdio transport.
 * This connects stdin/stdout for MCP communication.
 *
 * Should only be called when MCP mode is explicitly enabled,
 * since it takes over stdin/stdout.
 *
 * @param {McpServer} server - The configured MCP server
 * @returns {Promise<void>}
 */
export async function startMcpStdio(server) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP server started on stdio transport');
}

/**
 * Check if MCP mode is enabled via env var or CLI flag.
 *
 * @returns {boolean}
 */
export function isMcpEnabled() {
    return process.env.MCP_ENABLED === 'true' || process.argv.includes('--mcp');
}
