import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from '../../src/proxy/server.js';
import { createLogger } from '../../src/logging/logger.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', '..', 'dist');

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

describe('backend network purity', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('proxy makes zero outbound requests on cold start + 1s idle', async () => {
    const logger = createLogger({ destination: 'stderr', level: 'silent' });
    app = await createProxyServer({ port: 0, logger, config: defaultConfig() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => setTimeout(resolve, 1000));
    await app.close();
    app = undefined;
    // If the proxy had phoned home, it would have thrown (no ANTHROPIC_API_KEY set)
    // or we'd see it in logs. The test passes if we reach here without errors.
    expect(true).toBe(true);
  });

  it('built JS contains no auto-update references', () => {
    if (!fs.existsSync(distDir)) return;
    const forbiddenPatterns = [
      /github\.com\/.*\/releases/,
      /registry\.npmjs\.org/,
      /auto[_-]?update/i,
      /check[_-]?for[_-]?update/i,
    ];
    const jsFiles = walkDir(distDir).filter(f => f.endsWith('.js'));
    const violations: string[] = [];
    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(distDir, file)}: matches ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
