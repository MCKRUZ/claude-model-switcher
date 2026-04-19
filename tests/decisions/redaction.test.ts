import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Signals } from '../../src/signals/types.js';
import { hash12, redactContent, redactSignals } from '../../src/decisions/redaction.js';

const CLI_DIR = join(process.cwd(), 'src', 'cli');

function mkSignals(over: Partial<Signals> = {}): Signals {
  return {
    planMode: false,
    messageCount: 3,
    tools: ['bash', 'read'],
    toolUseCount: 2,
    estInputTokens: 1234,
    fileRefCount: 1,
    retryCount: 0,
    frustration: false,
    explicitModel: 'claude-opus-4-7',
    projectPath: '/home/user/proj',
    sessionDurationMs: 60_000,
    betaFlags: ['beta-flag-1'],
    sessionId: 'sess-1',
    requestHash: 'rh-1',
    ...over,
  };
}

describe('redaction', () => {
  it('hashed mode replaces sensitive strings with 12-char hex digests', () => {
    const r = redactSignals(mkSignals(), 'hashed') as Record<string, unknown>;
    expect(r.projectPath).toBe(hash12('/home/user/proj'));
    expect(r.explicitModel).toBe(hash12('claude-opus-4-7'));
    expect(Array.isArray(r.tools)).toBe(true);
    expect((r.tools as string[]).every((t) => /^[0-9a-f]{12}$/.test(t))).toBe(true);
  });

  it('hashed mode keeps identical inputs linkable (collision intentional)', () => {
    const a = redactSignals(mkSignals({ projectPath: '/p' }), 'hashed') as Record<string, unknown>;
    const b = redactSignals(mkSignals({ projectPath: '/p' }), 'hashed') as Record<string, unknown>;
    expect(a.projectPath).toBe(b.projectPath);
  });

  it('full mode preserves the raw signal values', () => {
    const r = redactSignals(mkSignals(), 'full') as Record<string, unknown>;
    expect(r.projectPath).toBe('/home/user/proj');
    expect(r.tools).toEqual(['bash', 'read']);
  });

  it('none mode drops content fields entirely (tools/explicitModel/projectPath/betaFlags)', () => {
    const r = redactSignals(mkSignals(), 'none') as Record<string, unknown>;
    expect('tools' in r).toBe(false);
    expect('explicitModel' in r).toBe(false);
    expect('projectPath' in r).toBe(false);
    expect('betaFlags' in r).toBe(false);
    // Counts/metadata still present.
    expect(r.toolCount).toBe(2);
    expect(r.betaFlagCount).toBe(1);
    expect(r.messageCount).toBe(3);
  });

  it('redactContent in none mode returns undefined', () => {
    expect(redactContent({ secret: 'abc' }, 'none')).toBeUndefined();
  });

  it('redactContent in hashed mode returns a 12-char digest', () => {
    const out = redactContent({ secret: 'abc' }, 'hashed');
    expect(typeof out).toBe('string');
    expect((out as string).length).toBe(12);
  });

  it('redactContent in full mode throws if the object contains a forbidden auth header', () => {
    expect(() => redactContent({ authorization: 'Bearer x' }, 'full')).toThrow(/forbidden header/i);
    expect(() => redactContent({ 'x-api-key': 'sk-x' }, 'full')).toThrow();
    expect(() => redactContent({ 'x-ccmux-token': 't' }, 'full')).toThrow();
  });

  it('no CLI flag exists to toggle the privacy mode (config-only)', () => {
    const sources = readdirSync(CLI_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(CLI_DIR, f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/--content\b/);
    expect(sources).not.toMatch(/--privacy\b/);
    expect(sources).not.toMatch(/--redact\b/);
  });
});
