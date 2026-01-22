/**
 * Conversations Browser
 */

import {
    fetchConversations,
    fetchConversation,
    fetchConversationEntries,
    fetchConversationArtifacts,
    fetchConversationStats
} from './api.js';

// State
let selectedConversationId = null;
let currentTab = 'entries';
let conversationData = null;
let entriesData = [];
let artifactsData = [];

// DOM Elements
const convList = document.getElementById('convList');
const convDetail = document.getElementById('convDetail');
const artifactPanel = document.getElementById('artifactPanel');
const artifactContent = document.getElementById('artifactContent');
const filterErrors = document.getElementById('filterErrors');
const closeArtifact = document.getElementById('closeArtifact');
const layout = document.querySelector('.conversations-layout');

// Initialize
async function init() {
    await loadConversations();
    setupEventListeners();
}

// Event Listeners
function setupEventListeners() {
    filterErrors.addEventListener('change', () => loadConversations());
    closeArtifact.addEventListener('click', hideArtifactPanel);
}

// Load conversation list
async function loadConversations() {
    convList.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const params = { limit: 50 };
        if (filterErrors.checked) {
            params.hasErrors = true;
        }

        const result = await fetchConversations(params);
        renderConversationList(result.data);
    } catch (err) {
        convList.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

// Render conversation list
function renderConversationList(conversations) {
    if (!conversations.length) {
        convList.innerHTML = '<div class="empty-state"><p>No conversations found</p></div>';
        return;
    }

    convList.innerHTML = conversations.map(conv => {
        const startDate = conv.started_at ? new Date(conv.started_at) : null;
        const dateStr = startDate ? formatDate(startDate) : 'Unknown date';
        const timeStr = startDate ? formatTime(startDate) : '';
        const duration = formatDuration(conv.duration_seconds);

        return `
            <div class="conv-item ${conv.id === selectedConversationId ? 'selected' : ''}"
                 data-id="${conv.id}">
                <div class="conv-item-header">
                    <span class="conv-date">${dateStr}</span>
                    <div class="conv-badges">
                        ${conv.error_count > 0 ? `<span class="error-badge">${conv.error_count} errors</span>` : ''}
                    </div>
                </div>
                <div class="conv-item-meta">
                    <span>${timeStr}</span>
                    <span>${conv.message_count} msgs</span>
                    <span>${conv.artifact_count} artifacts</span>
                    ${duration ? `<span>${duration}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers
    convList.querySelectorAll('.conv-item').forEach(item => {
        item.addEventListener('click', () => selectConversation(parseInt(item.dataset.id)));
    });
}

// Select a conversation
async function selectConversation(id) {
    selectedConversationId = id;

    // Update selection in list
    convList.querySelectorAll('.conv-item').forEach(item => {
        item.classList.toggle('selected', parseInt(item.dataset.id) === id);
    });

    // Load conversation details
    convDetail.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const [conv, entries, artifacts, stats] = await Promise.all([
            fetchConversation(id),
            fetchConversationEntries(id, { limit: 100 }),
            fetchConversationArtifacts(id, { limit: 100 }),
            fetchConversationStats(id)
        ]);

        conversationData = conv;
        entriesData = entries.data;
        artifactsData = artifacts.data;

        renderConversationDetail(conv, stats);
    } catch (err) {
        convDetail.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

// Render conversation detail
function renderConversationDetail(conv, stats) {
    const startDate = conv.started_at ? new Date(conv.started_at) : null;
    const dateStr = startDate ? formatDateTime(startDate) : 'Unknown';
    const duration = formatDuration(conv.duration_seconds);

    const toolCalls = artifactsData.filter(a => a.artifact_type === 'tool_call');
    const codeBlocks = artifactsData.filter(a => a.artifact_type === 'code_block');
    const errors = artifactsData.filter(a => a.outcome === 'error');

    convDetail.innerHTML = `
        <div class="conv-detail-header">
            <h2>Conversation ${conv.conversation_id?.slice(0, 8) || conv.id}</h2>
            <div class="conv-detail-meta">
                <span>Started: ${dateStr}</span>
                ${duration ? `<span>Duration: ${duration}</span>` : ''}
                ${conv.git_branch ? `<span>Branch: ${conv.git_branch}</span>` : ''}
                ${conv.model_used ? `<span>Model: ${conv.model_used}</span>` : ''}
            </div>
        </div>

        <div class="conv-tabs">
            <button class="tab-btn ${currentTab === 'entries' ? 'active' : ''}" data-tab="entries">
                Entries <span class="count">${entriesData.length}</span>
            </button>
            <button class="tab-btn ${currentTab === 'tools' ? 'active' : ''}" data-tab="tools">
                Tool Calls <span class="count">${toolCalls.length}</span>
            </button>
            <button class="tab-btn ${currentTab === 'code' ? 'active' : ''}" data-tab="code">
                Code <span class="count">${codeBlocks.length}</span>
            </button>
            <button class="tab-btn ${currentTab === 'errors' ? 'active' : ''}" data-tab="errors">
                Errors <span class="count">${errors.length}</span>
            </button>
        </div>

        <div id="tabEntries" class="tab-content ${currentTab === 'entries' ? 'active' : ''}">
            ${renderEntries(entriesData)}
        </div>

        <div id="tabTools" class="tab-content ${currentTab === 'tools' ? 'active' : ''}">
            ${renderArtifacts(toolCalls)}
        </div>

        <div id="tabCode" class="tab-content ${currentTab === 'code' ? 'active' : ''}">
            ${renderArtifacts(codeBlocks)}
        </div>

        <div id="tabErrors" class="tab-content ${currentTab === 'errors' ? 'active' : ''}">
            ${renderArtifacts(errors)}
        </div>
    `;

    // Tab click handlers
    convDetail.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Artifact click handlers
    convDetail.querySelectorAll('.artifact-item').forEach(item => {
        item.addEventListener('click', () => showArtifact(parseInt(item.dataset.id)));
    });
}

// Render entries
function renderEntries(entries) {
    if (!entries.length) {
        return '<div class="empty-state"><p>No entries</p></div>';
    }

    return entries.map(entry => {
        const time = entry.timestamp ? formatTime(new Date(entry.timestamp)) : '';
        const content = truncate(entry.content, 500);

        return `
            <div class="entry-item">
                <div class="entry-header">
                    <span class="entry-role ${entry.role}">${entry.role}</span>
                    <span class="entry-time">${time}</span>
                </div>
                <div class="entry-content">${escapeHtml(content)}</div>
            </div>
        `;
    }).join('');
}

// Render artifacts
function renderArtifacts(artifacts) {
    if (!artifacts.length) {
        return '<div class="empty-state"><p>No artifacts</p></div>';
    }

    return artifacts.map(artifact => {
        const preview = artifact.content ? truncate(artifact.content, 100) : '';
        const isError = artifact.outcome === 'error';

        return `
            <div class="artifact-item ${isError ? 'error' : ''}" data-id="${artifact.id}">
                <div class="artifact-header">
                    <div class="artifact-type">
                        <span class="artifact-type-badge ${artifact.artifact_type}">${formatArtifactType(artifact.artifact_type)}</span>
                        ${artifact.tool_name ? `<span class="artifact-tool">${artifact.tool_name}</span>` : ''}
                        ${artifact.language ? `<span class="artifact-tool">${artifact.language}</span>` : ''}
                    </div>
                    ${artifact.outcome ? `<span class="artifact-outcome ${artifact.outcome}">${artifact.outcome}</span>` : ''}
                </div>
                <div class="artifact-preview">${escapeHtml(preview)}</div>
            </div>
        `;
    }).join('');
}

// Switch tabs
function switchTab(tab) {
    currentTab = tab;

    convDetail.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    convDetail.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab${capitalize(tab)}`);
    });
}

// Show artifact detail
function showArtifact(id) {
    const artifact = artifactsData.find(a => a.id === id);
    if (!artifact) return;

    layout.classList.add('show-artifact');

    artifactContent.innerHTML = `
        <div class="artifact-type">
            <span class="artifact-type-badge ${artifact.artifact_type}">${formatArtifactType(artifact.artifact_type)}</span>
            ${artifact.tool_name ? `<span class="artifact-tool">${artifact.tool_name}</span>` : ''}
            ${artifact.language ? `<span class="artifact-tool">${artifact.language}</span>` : ''}
        </div>

        ${artifact.outcome ? `
            <div style="margin-top: 12px;">
                <span class="artifact-outcome ${artifact.outcome}">${artifact.outcome}</span>
                ${artifact.error_type ? `<span style="margin-left: 8px; color: var(--text-secondary);">(${artifact.error_type})</span>` : ''}
            </div>
        ` : ''}

        ${artifact.content ? `
            <div class="artifact-full-content">
                ${artifact.language ? `<div class="code-lang">${artifact.language}</div>` : ''}
                <pre><code>${escapeHtml(artifact.content)}</code></pre>
            </div>
        ` : ''}

        ${artifact.output_summary ? `
            <div class="artifact-meta">
                <h4 style="margin-bottom: 8px;">Output</h4>
                <div class="artifact-full-content">
                    <pre><code>${escapeHtml(artifact.output_full || artifact.output_summary)}</code></pre>
                </div>
                ${artifact.output_truncated ? `<div style="margin-top: 8px; color: var(--text-secondary); font-size: 0.8rem;">Output truncated (${formatBytes(artifact.output_size_bytes)} total)</div>` : ''}
            </div>
        ` : ''}

        ${artifact.prompt_context ? `
            <div class="artifact-meta">
                <h4 style="margin-bottom: 8px;">Prompt Context</h4>
                <div class="artifact-full-content">
                    <pre><code>${escapeHtml(artifact.prompt_context)}</code></pre>
                </div>
            </div>
        ` : ''}

        <div class="artifact-meta">
            <div class="artifact-meta-item">
                <span class="artifact-meta-label">Created:</span>
                <span>${artifact.created_at}</span>
            </div>
            ${artifact.metadata ? `
                <div class="artifact-meta-item">
                    <span class="artifact-meta-label">Metadata:</span>
                    <span>${JSON.stringify(artifact.metadata)}</span>
                </div>
            ` : ''}
        </div>
    `;
}

// Hide artifact panel
function hideArtifactPanel() {
    layout.classList.remove('show-artifact');
}

// Utility functions
function formatDate(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDateTime(date) {
    return date.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
    });
}

function formatDuration(seconds) {
    if (!seconds) return null;
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

function formatArtifactType(type) {
    const map = {
        'code_block': 'Code',
        'tool_call': 'Tool Call',
        'tool_result': 'Result',
        'json_object': 'JSON'
    };
    return map[type] || type;
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Start
init();
