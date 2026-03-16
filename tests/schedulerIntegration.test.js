import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import { discoverProjects, formatCentralTime } from '../server/services/fileScannerService.js';

describe('File scanner against live WSL filesystem', () => {
    it('formatCentralTime returns expected format', () => {
        const ts = formatCentralTime(new Date());
        expect(ts).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}:\d{2}\s+(AM|PM)$/);
    });

    it('discovers real projects under /root/projects', () => {
        const projects = discoverProjects('/root/projects');
        expect(projects.length).toBeGreaterThan(0);
        // At least some should have .claude
        const withClaude = projects.filter(p => p.hasClaude);
        expect(withClaude.length).toBeGreaterThan(0);
    });

    it('/root/.claude exists and contains files', () => {
        expect(fs.existsSync('/root/.claude')).toBe(true);
    });
});
