import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = join(__dirname, '../../../src/dashboard/frontend/dist');
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/;
// React DOM and Recharts embed W3C namespace URIs and dev-mode doc links
// as string literals — not fetched at runtime.
const LIBRARY_INTERNALS = /^https?:\/\/(www\.w3\.org|fb\.me|reactjs\.org)\//;
const URL_PATTERN = /https?:\/\/[^\s"'`,)\]}>]*/g;

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

describe('self-containment: no outbound URLs', () => {
  let violations: { file: string; url: string }[];

  beforeAll(() => {
    violations = [];
    const files = walkDir(DIST_DIR);
    for (const file of files) {
      if (/\.(html|js|css|map|json)$/.test(file)) {
        const content = readFileSync(file, 'utf8');
        const matches = content.match(URL_PATTERN) ?? [];
        for (const url of matches) {
          if (!LOOPBACK.test(url) && !LIBRARY_INTERNALS.test(url)) {
            violations.push({ file: file.replace(DIST_DIR, ''), url });
          }
        }
      }
    }
  });

  it('dist/ exists after build', () => {
    expect(existsSync(DIST_DIR)).toBe(true);
  });

  it('contains zero outbound URLs (only 127.0.0.1/localhost allowed)', () => {
    expect(violations).toEqual([]);
  });
});
