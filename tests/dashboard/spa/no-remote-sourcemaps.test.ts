import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = join(__dirname, '../../../src/dashboard/frontend/dist');
const SOURCEMAP_PATTERN = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/g;

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

describe('self-containment: no remote source maps', () => {
  let remoteSourcemaps: { file: string; url: string }[];

  beforeAll(() => {
    remoteSourcemaps = [];
    const files = walkDir(DIST_DIR).filter(f => /\.(js|css)$/.test(f));
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      let match;
      while ((match = SOURCEMAP_PATTERN.exec(content)) !== null) {
        const url = match[1]!;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          remoteSourcemaps.push({ file: file.replace(DIST_DIR, ''), url });
        }
      }
    }
  });

  it('all sourceMappingURL values are relative, data: URIs, or absent', () => {
    expect(remoteSourcemaps).toEqual([]);
  });
});
