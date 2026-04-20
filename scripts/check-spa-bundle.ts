// SPA bundle URL scanner — flags non-local URLs in the dashboard dist.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScanViolation {
  readonly file: string;
  readonly line: number;
  readonly url: string;
}

export interface ScanResult {
  readonly clean: boolean;
  readonly violations: readonly ScanViolation[];
}

const URL_PATTERN = /https?:\/\/[^\s"'`,)}\]]+/g;

const ALLOWLIST: readonly RegExp[] = [
  /^https?:\/\/localhost(:\d+)?/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?/,
  /^http:\/\/www\.w3\.org\//,
];

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

export function scanBundleDir(distDir: string, extraAllowlist?: readonly RegExp[]): ScanResult {
  const allow = extraAllowlist ? [...ALLOWLIST, ...extraAllowlist] : ALLOWLIST;
  const files = walkDir(distDir).filter(f => /\.(js|css|html|json)$/.test(f));
  const violations: ScanViolation[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i]!.matchAll(URL_PATTERN);
      for (const m of matches) {
        const url = m[0];
        if (!allow.some(re => re.test(url))) {
          violations.push({ file: relative(distDir, file), line: i + 1, url });
        }
      }
    }
  }

  return { clean: violations.length === 0, violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const distDir = process.argv[2] ?? 'src/dashboard/frontend/dist';
  const result = scanBundleDir(distDir);
  if (!result.clean) {
    console.error('SPA bundle contains non-local URLs:');
    for (const v of result.violations) {
      console.error(`  ${v.file}:${v.line} → ${v.url}`);
    }
    process.exit(1);
  }
  console.log('SPA bundle URL check passed.');
}
