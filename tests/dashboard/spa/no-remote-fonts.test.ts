import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = join(__dirname, '../../../src/dashboard/frontend/dist');
const FONT_URL_PATTERN = /url\s*\(\s*['"]?(https?:\/\/[^'")\s]+)/gi;

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

describe('self-containment: no remote fonts', () => {
  let remoteFonts: { file: string; url: string }[];

  beforeAll(() => {
    remoteFonts = [];
    const cssFiles = walkDir(DIST_DIR).filter(f => f.endsWith('.css'));
    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      let match;
      while ((match = FONT_URL_PATTERN.exec(content)) !== null) {
        remoteFonts.push({ file: file.replace(DIST_DIR, ''), url: match[1]! });
      }
    }
  });

  it('all @font-face url() values are relative or data: URIs', () => {
    expect(remoteFonts).toEqual([]);
  });
});
