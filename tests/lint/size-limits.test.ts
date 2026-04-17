import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
}

function makeLongFunction(bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `  const a${i} = ${i};`).join('\n');
  return `export function tooLong(): void {\n${body}\n}\n`;
}

function lintFixture(
  fixturePath: string,
  content: string,
  kind: 'src' | 'tests'
): Promise<ESLint.LintResult[]> {
  writeFileSync(fixturePath, content, 'utf8');
  const eslint = new ESLint({
    useEslintrc: false,
    overrideConfig: {
      parser: '@typescript-eslint/parser',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      plugins: ['@typescript-eslint'],
      rules:
        kind === 'src'
          ? {
              'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
              'max-lines-per-function': [
                'error',
                { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true },
              ],
            }
          : {
              'max-lines-per-function': ['error', { max: 200 }],
            },
    },
  });
  return eslint.lintFiles([fixturePath]);
}

describe('repo lint — file size cap', () => {
  it('rejects a new src/ file above 400 lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccmux-lint-'));
    const file = join(dir, 'oversize.ts');
    try {
      const results = await lintFixture(file, makeLines(401), 'src');
      const messages = results.flatMap((r) => r.messages);
      const violation = messages.find((m) => m.ruleId === 'max-lines');
      expect(violation, 'expected max-lines violation').toBeDefined();
      expect(results[0]?.filePath).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a new function above 50 lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccmux-lint-'));
    const file = join(dir, 'bigfn.ts');
    try {
      const results = await lintFixture(file, makeLongFunction(51), 'src');
      const messages = results.flatMap((r) => r.messages);
      const violation = messages.find((m) => m.ruleId === 'max-lines-per-function');
      expect(violation, 'expected max-lines-per-function violation').toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
