import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanBundleDir } from '../../scripts/check-spa-bundle.js';

describe('check-spa-bundle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-bundle-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits clean when all URLs are localhost', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.js'),
      'const url = "http://localhost:8787/api";\nconst ws = "http://127.0.0.1:3000/ws";\n',
    );
    const result = scanBundleDir(tmpDir);
    expect(result.clean).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('flags external URLs', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'vendor.js'),
      'const cdn = "https://cdn.example.com/lib.js";\n',
    );
    const result = scanBundleDir(tmpDir);
    expect(result.clean).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]!.url).toContain('cdn.example.com');
  });

  it('allows W3 schema URIs used by SVG/Recharts', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'chart.js'),
      'const x = "http://www.w3.org/2000/svg";\nconst y = "http://www.w3.org/1999/xlink";\n',
    );
    const result = scanBundleDir(tmpDir);
    expect(result.clean).toBe(true);
  });

  it('scans nested directories', () => {
    const subDir = path.join(tmpDir, 'assets', 'js');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'deep.js'), 'fetch("https://evil.com/track");\n');
    const result = scanBundleDir(tmpDir);
    expect(result.clean).toBe(false);
    expect(result.violations[0]!.file).toContain('deep.js');
  });

  it('ignores non-code files', () => {
    fs.writeFileSync(path.join(tmpDir, 'image.png'), 'https://evil.com/not-scanned');
    const result = scanBundleDir(tmpDir);
    expect(result.clean).toBe(true);
  });

  it('reports file and line number for violations', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.js'),
      'const a = 1;\nconst b = "https://tracking.example.com/pixel";\nconst c = 3;\n',
    );
    const result = scanBundleDir(tmpDir);
    expect(result.violations[0]!.line).toBe(2);
  });
});
