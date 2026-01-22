/**
 * Formatting utilities
 */

/**
 * Format file size in human-readable form
 */
export function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Format size delta with sign and color class
 */
export function formatDelta(delta) {
    if (delta === null || delta === undefined) return '';

    const sign = delta >= 0 ? '+' : '';
    const cls = delta > 0 ? 'delta-positive' : delta < 0 ? 'delta-negative' : '';
    const formatted = formatSize(Math.abs(delta));

    return `<span class="${cls}">${sign}${formatted}</span>`;
}

/**
 * Shorten file path for display
 */
export function shortenPath(path) {
    if (!path) return '';
    return path
        .replace(/^C:\\Users\\Steve\\.claude\\/, '.claude\\')
        .replace(/^C:\\MyStuff\\/, '')
        .replace(/\\.claude\\/g, '\\.claude\\');
}

/**
 * Format date for input[type=date]
 */
export function formatInputDate(date) {
    return date.toISOString().split('T')[0];
}

/**
 * Parse input date string to Date
 */
export function parseInputDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/**
 * Format date as MM-DD-YY for API
 */
export function formatApiDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    return `${mm}-${dd}-${yy}`;
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
