/**
 * API Client for Claude Monitor
 */

const API_BASE = '/api/v1';

/**
 * Fetch with error handling
 */
async function fetchJson(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        if (err.message === 'Failed to fetch') {
            throw new Error('Cannot connect to server');
        }
        throw err;
    }
}

/**
 * Get scans with pagination and filtering
 */
export async function fetchScans(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);
    if (params.startDate) searchParams.set('startDate', params.startDate);
    if (params.endDate) searchParams.set('endDate', params.endDate);
    if (params.hasChanges !== undefined) searchParams.set('hasChanges', params.hasChanges);

    const query = searchParams.toString();
    return fetchJson(`${API_BASE}/scans${query ? '?' + query : ''}`);
}

/**
 * Get single scan by ID
 */
export async function fetchScanById(id) {
    return fetchJson(`${API_BASE}/scans/${id}`);
}

/**
 * Get all scans for a specific date
 */
export async function fetchScansByDate(date) {
    return fetchJson(`${API_BASE}/scans/by-date/${date}`);
}

/**
 * Get tracked files
 */
export async function fetchFiles(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.projectId) searchParams.set('projectId', params.projectId);
    if (params.includeDeleted) searchParams.set('includeDeleted', 'true');
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);

    const query = searchParams.toString();
    return fetchJson(`${API_BASE}/files${query ? '?' + query : ''}`);
}

/**
 * Get file history
 */
export async function fetchFileHistory(fileId, limit = 50) {
    return fetchJson(`${API_BASE}/files/${fileId}/history?limit=${limit}`);
}

/**
 * Get aggregate statistics
 */
export async function fetchStats(period = 'day') {
    return fetchJson(`${API_BASE}/stats?period=${period}`);
}

/**
 * Get change trends
 */
export async function fetchTrends(days = 7, granularity = 'hour') {
    return fetchJson(`${API_BASE}/stats/trends?days=${days}&granularity=${granularity}`);
}

/**
 * Health check
 */
export async function checkHealth() {
    try {
        const result = await fetchJson(`${API_BASE}/health`);
        return { connected: true, ...result };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

// ============================================================
// Conversation API
// ============================================================

/**
 * Get conversations with filtering
 */
export async function fetchConversations(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.projectId) searchParams.set('project_id', params.projectId);
    if (params.since) searchParams.set('since', params.since);
    if (params.hasErrors) searchParams.set('has_errors', 'true');
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);

    const query = searchParams.toString();
    return fetchJson(`${API_BASE}/conversations${query ? '?' + query : ''}`);
}

/**
 * Get single conversation
 */
export async function fetchConversation(id) {
    return fetchJson(`${API_BASE}/conversations/${id}`);
}

/**
 * Get conversation entries
 */
export async function fetchConversationEntries(id, params = {}) {
    const searchParams = new URLSearchParams();
    if (params.role) searchParams.set('role', params.role);
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);

    const query = searchParams.toString();
    return fetchJson(`${API_BASE}/conversations/${id}/entries${query ? '?' + query : ''}`);
}

/**
 * Get conversation artifacts
 */
export async function fetchConversationArtifacts(id, params = {}) {
    const searchParams = new URLSearchParams();
    if (params.type) searchParams.set('type', params.type);
    if (params.toolName) searchParams.set('tool_name', params.toolName);
    if (params.outcome) searchParams.set('outcome', params.outcome);
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);

    const query = searchParams.toString();
    return fetchJson(`${API_BASE}/conversations/${id}/artifacts${query ? '?' + query : ''}`);
}

/**
 * Get conversation stats
 */
export async function fetchConversationStats(id) {
    return fetchJson(`${API_BASE}/conversations/${id}/stats`);
}

/**
 * Search artifacts
 */
export async function searchArtifacts(query, params = {}) {
    const searchParams = new URLSearchParams();
    searchParams.set('q', query);
    if (params.projectId) searchParams.set('project_id', params.projectId);
    if (params.type) searchParams.set('type', params.type);
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);

    return fetchJson(`${API_BASE}/artifacts/search?${searchParams.toString()}`);
}

/**
 * Get artifact stats
 */
export async function fetchArtifactStats() {
    return fetchJson(`${API_BASE}/artifacts/stats`);
}

/**
 * Get config snapshots
 */
export async function fetchConfigSnapshots(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.projectId) searchParams.set('project_id', params.projectId);
    if (params.fileType) searchParams.set('file_type', params.fileType);
    if (params.page) searchParams.set('page', params.page);
    if (params.limit) searchParams.set('limit', params.limit);

    const query = searchParams.toString();
    return fetchJson(`${API_BASE}/config-snapshots${query ? '?' + query : ''}`);
}
