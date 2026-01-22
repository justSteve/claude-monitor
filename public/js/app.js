/**
 * Claude File Monitor - Main Application
 */

import { fetchScansByDate, fetchStats, checkHealth } from './api.js';
import { formatSize, formatDelta, shortenPath, formatInputDate, parseInputDate, formatApiDate, escapeHtml } from './utils/formatting.js';

// Application state
const state = {
    currentDate: new Date(),
    autoRefreshInterval: null,
    pollIntervalMs: 30000
};

// DOM Elements
const elements = {
    timeline: document.getElementById('timeline'),
    dateSelector: document.getElementById('dateSelector'),
    prevDay: document.getElementById('prevDay'),
    nextDay: document.getElementById('nextDay'),
    autoRefresh: document.getElementById('autoRefresh'),
    pollInterval: document.getElementById('pollInterval'),
    statScans: document.getElementById('statScans'),
    statProjects: document.getElementById('statProjects'),
    statChanges: document.getElementById('statChanges'),
    statFiles: document.getElementById('statFiles')
};

/**
 * Render timeline with scans
 */
function renderTimeline(scans) {
    if (!scans || scans.length === 0) {
        elements.timeline.innerHTML = '<div class="no-changes">No scans for this date</div>';
        updateStats(null);
        return;
    }

    // Newest first
    const sortedScans = [...scans].reverse();
    updateStats(sortedScans);

    elements.timeline.innerHTML = sortedScans.map((scan, index) => {
        const hasChanges = scan.filesWithChange && scan.filesWithChange.length > 0;
        const newCount = scan.filesWithChange?.filter(f => f.status === 'NEW').length || 0;
        const modCount = scan.filesWithChange?.filter(f => f.status === 'MODIFIED').length || 0;
        const delCount = scan.filesWithChange?.filter(f => f.status === 'DELETED').length || 0;

        return `
            <div class="scan-card ${index === 0 && hasChanges ? 'expanded' : ''}" data-index="${index}">
                <div class="scan-header" onclick="window.toggleCard(${index})">
                    <div>
                        <div class="scan-time">${escapeHtml(scan.scanTime)}</div>
                        <div class="scan-summary">
                            ${newCount > 0 ? `<span class="badge badge-new">${newCount} new</span>` : ''}
                            ${modCount > 0 ? `<span class="badge badge-modified">${modCount} modified</span>` : ''}
                            ${delCount > 0 ? `<span class="badge badge-deleted">${delCount} deleted</span>` : ''}
                            <span class="badge badge-unchanged">${scan.filesNoChange || 0} unchanged</span>
                        </div>
                    </div>
                    <div class="scan-meta">
                        ${scan.projectsScanned ? `<span>${scan.projectsScanned} projects</span>` : ''}
                        <span>${scan.scanDurationMs}ms</span>
                        <span class="expand-icon">${hasChanges ? '&#9660;' : ''}</span>
                    </div>
                </div>
                ${hasChanges ? `
                    <div class="scan-files">
                        ${scan.filesWithChange.map(file => `
                            <div class="file-item">
                                <span class="file-status ${file.status}">${file.status}</span>
                                <div class="file-info">
                                    <div class="file-path">${escapeHtml(shortenPath(file.path))}</div>
                                    <div class="file-details">
                                        ${formatSize(file.sizeBytes)}
                                        ${file.deltaSizeBytes !== null ? ` (${formatDelta(file.deltaSizeBytes)})` : ''}
                                        &middot; ${escapeHtml(file.lastModified)}
                                        ${file.attributes && file.attributes.length ? ` &middot; [${file.attributes.join(', ')}]` : ''}
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

/**
 * Update stats panel
 */
function updateStats(scans) {
    if (!scans || scans.length === 0) {
        elements.statScans.textContent = '-';
        elements.statProjects.textContent = '-';
        elements.statChanges.textContent = '-';
        elements.statFiles.textContent = '-';
        return;
    }

    const latestScan = scans[0];
    const totalChanges = scans.reduce((sum, s) => sum + (s.filesWithChange?.length || 0), 0);
    const totalFiles = (latestScan.filesNoChange || 0) + (latestScan.filesWithChange?.length || 0);

    elements.statScans.textContent = scans.length;
    elements.statProjects.textContent = latestScan.projectsScanned || '-';
    elements.statChanges.textContent = totalChanges;
    elements.statFiles.textContent = totalFiles;
}

/**
 * Toggle card expansion
 */
window.toggleCard = function(index) {
    const card = document.querySelector(`.scan-card[data-index="${index}"]`);
    if (card && card.querySelector('.scan-files')) {
        card.classList.toggle('expanded');
    }
};

/**
 * Load scans for current date
 */
async function loadCurrentDate() {
    elements.timeline.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const dateStr = formatApiDate(state.currentDate);
        const scans = await fetchScansByDate(dateStr);
        renderTimeline(scans);
    } catch (err) {
        elements.timeline.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
        updateStats(null);
    }
}

/**
 * Navigate to different date
 */
function navigateDate(delta) {
    state.currentDate = new Date(state.currentDate);
    state.currentDate.setDate(state.currentDate.getDate() + delta);
    elements.dateSelector.value = formatInputDate(state.currentDate);
    updateNavButtons();
    loadCurrentDate();
}

/**
 * Update navigation button states
 */
function updateNavButtons() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const current = new Date(state.currentDate);
    current.setHours(0, 0, 0, 0);

    elements.nextDay.disabled = current >= today;
}

/**
 * Toggle auto-refresh
 */
function toggleAutoRefresh() {
    if (state.autoRefreshInterval) {
        clearInterval(state.autoRefreshInterval);
        state.autoRefreshInterval = null;
        elements.autoRefresh.classList.remove('active');
    } else {
        state.autoRefreshInterval = setInterval(loadCurrentDate, state.pollIntervalMs);
        elements.autoRefresh.classList.add('active');
        loadCurrentDate(); // Immediate refresh
    }
}

/**
 * Update poll interval
 */
function updatePollInterval() {
    state.pollIntervalMs = parseInt(elements.pollInterval.value) || 30000;

    // Restart auto-refresh with new interval if active
    if (state.autoRefreshInterval) {
        clearInterval(state.autoRefreshInterval);
        if (state.pollIntervalMs > 0) {
            state.autoRefreshInterval = setInterval(loadCurrentDate, state.pollIntervalMs);
        } else {
            state.autoRefreshInterval = null;
            elements.autoRefresh.classList.remove('active');
        }
    }
}

/**
 * Initialize application
 */
async function init() {
    // Set up date selector
    elements.dateSelector.value = formatInputDate(state.currentDate);
    elements.dateSelector.max = formatInputDate(new Date());

    // Event listeners
    elements.dateSelector.addEventListener('change', (e) => {
        state.currentDate = parseInputDate(e.target.value);
        updateNavButtons();
        loadCurrentDate();
    });

    elements.prevDay.addEventListener('click', () => navigateDate(-1));
    elements.nextDay.addEventListener('click', () => navigateDate(1));
    elements.autoRefresh.addEventListener('click', toggleAutoRefresh);
    elements.pollInterval.addEventListener('change', updatePollInterval);

    updateNavButtons();

    // Check API health
    const health = await checkHealth();
    if (!health.connected) {
        elements.timeline.innerHTML = `<div class="error">Cannot connect to server: ${escapeHtml(health.error)}</div>`;
        return;
    }

    // Load initial data
    loadCurrentDate();
}

// Start application
init();
