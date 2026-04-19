import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_HTML = join(__dirname, '../../../src/dashboard/frontend/dist/index.html');

describe('self-containment: no CDN in HTML', () => {
  it('dist/index.html exists', () => {
    expect(existsSync(INDEX_HTML)).toBe(true);
  });

  it('no external link/script/img references', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');

    const srcPattern = /(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
    const violations: string[] = [];
    let match;
    while ((match = srcPattern.exec(html)) !== null) {
      const url = match[1]!;
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
        violations.push(url);
      }
    }

    expect(violations).toEqual([]);
  });

  it('no Google Fonts or CDN references', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('cdn.');
    expect(html).not.toContain('unpkg.com');
    expect(html).not.toContain('jsdelivr');
  });
});
