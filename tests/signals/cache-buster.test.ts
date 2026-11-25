// Cache-buster detector, exercised through extractSignals (its only entry point).
import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { PassThrough } from 'node:stream';
import { extractSignals } from '../../src/signals/extract.js';
import {
  CACHE_BUSTER_MAX_ENTRIES,
  __resetCacheBusterForTests,
} from '../../src/signals/cache-buster.js';
import type { SessionContext, Signals } from '../../src/signals/types.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' }, new PassThrough());
}

function warningSink(sink: Array<Record<string, unknown>>): pino.Logger {
  const base = silentLogger();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'warn') {
        return (payload: unknown) => {
          if (payload && typeof payload === 'object') sink.push(payload as Record<string, unknown>);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as pino.Logger;
}

const CTX: SessionContext = { createdAt: Date.now(), retrySeen: () => 0 };

const READ_TOOL = {
  name: 'Read',
  description: 'Reads a file from disk.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
};

interface BodyParts {
  readonly system?: string;
  readonly tools?: readonly Record<string, unknown>[];
}

function extract(parts: BodyParts, logger: pino.Logger = silentLogger()): Signals {
  const body = {
    model: 'claude-sonnet-4-6',
    ...(parts.system !== undefined ? { system: parts.system } : {}),
    ...(parts.tools !== undefined ? { tools: parts.tools } : {}),
    messages: [{ role: 'user', content: 'hello' }],
  };
  return extractSignals(body, undefined, CTX, logger);
}

beforeEach(() => {
  __resetCacheBusterForTests();
});

describe('cache-buster detector', () => {
  it('flags two requests that differ only by an ISO date in the system prompt', () => {
    const first = extract({ system: 'You are helpful. Today is 2026-11-25. Be brief.', tools: [READ_TOOL] });
    const second = extract({ system: 'You are helpful. Today is 2026-11-26. Be brief.', tools: [READ_TOOL] });
    expect(first.cacheBuster).toBeUndefined();
    expect(second.cacheBuster?.kinds).toEqual(['date']);
    expect(second.cacheBuster?.prefix_fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not flag identical repeated requests', () => {
    const parts = { system: 'You are helpful. Today is 2026-11-25.', tools: [READ_TOOL] };
    expect(extract(parts).cacheBuster).toBeUndefined();
    expect(extract(parts).cacheBuster).toBeUndefined();
    expect(extract(parts).cacheBuster).toBeUndefined();
  });

  it('does not flag requests whose content genuinely differs', () => {
    extract({ system: 'You are helpful. Today is 2026-11-25.', tools: [READ_TOOL] });
    const editedSentence = extract({
      system: 'You are terse. Today is 2026-11-25.',
      tools: [READ_TOOL],
    });
    const newTool = extract({
      system: 'You are helpful. Today is 2026-11-26.',
      tools: [READ_TOOL, { name: 'Write', description: 'Writes a file.', input_schema: {} }],
    });
    expect(editedSentence.cacheBuster).toBeUndefined();
    expect(newTool.cacheBuster).toBeUndefined();
  });

  it('flags a date hidden in a tool description', () => {
    const tool = (date: string) => ({ ...READ_TOOL, description: `Reads files. Snapshot ${date}.` });
    extract({ system: 'Same.', tools: [tool('2026-11-25')] });
    const second = extract({ system: 'Same.', tools: [tool('2026-11-26')] });
    expect(second.cacheBuster?.kinds).toEqual(['date']);
  });

  it('flags a date placed after the first 4 KB of a long system prompt', () => {
    const filler = 'Follow the project conventions carefully. '.repeat(200);
    expect(filler.length).toBeGreaterThan(4096);
    extract({ system: `${filler}Today is 2026-11-25.` });
    const second = extract({ system: `${filler}Today is 2026-11-26.` });
    expect(second.cacheBuster?.kinds).toEqual(['date']);
  });

  it('reports date and time for an ISO-8601 date-time', () => {
    extract({ system: 'Started at 2026-11-25T14:46:54Z today.' });
    const second = extract({ system: 'Started at 2026-11-26T09:01:02Z today.' });
    expect(second.cacheBuster?.kinds).toEqual(['date', 'time']);
  });

  it('reports only the kinds that changed', () => {
    const sys = (date: string) =>
      `Today ${date}. Session 123e4567-e89b-12d3-a456-426614174000 is active.`;
    extract({ system: sys('2026-11-25') });
    const second = extract({ system: sys('2026-11-26') });
    expect(second.cacheBuster?.kinds).toEqual(['date']);
  });

  it('flags a changed UUID', () => {
    extract({ system: 'Session 123e4567-e89b-12d3-a456-426614174000 is active.' });
    const second = extract({ system: 'Session 9b2f6c1e-0d4a-4f7b-8c3e-5a1d2e3f4a5b is active.' });
    expect(second.cacheBuster?.kinds).toEqual(['uuid']);
  });

  it('flags a changed long hex id', () => {
    extract({ system: 'Build 0a1b2c3d4e5f60718293a4b5c6d7e8f9 is live.' });
    const second = extract({ system: 'Build f9e8d7c6b5a493827160f5e4d3c2b1a0 is live.' });
    expect(second.cacheBuster?.kinds).toEqual(['hex_id']);
  });

  it('does not mask short hex-looking words, so a changed one is real content', () => {
    extract({ system: 'The word is deadbeef here.' });
    const second = extract({ system: 'The word is feedface here.' });
    expect(second.cacheBuster).toBeUndefined();
  });

  it('never flags a request with no tools and no system prompt', () => {
    extract({});
    expect(extract({}).cacheBuster).toBeUndefined();
  });

  it('degrades to not flagged, without throwing, when the detector fails', () => {
    const warnings: Array<Record<string, unknown>> = [];
    const hostile = { name: 'Bad', description: 10n };
    const signals = extract({ system: 'x 2026-11-25', tools: [hostile] }, warningSink(warnings));
    expect(signals.cacheBuster).toBeUndefined();
    expect(warnings.some((w) => w.extractor === 'cache-buster')).toBe(true);
  });

  it('keeps no prompt text or raw values in the finding', () => {
    extract({ system: 'Secret plan for 2026-11-25 only.' });
    const second = extract({ system: 'Secret plan for 2026-11-26 only.' });
    const serialized = JSON.stringify(second.cacheBuster);
    expect(serialized).not.toContain('2026-11-2');
    expect(serialized).not.toContain('Secret');
  });

  it('forgets the oldest prefixes once the bounded memory is full', () => {
    extract({ system: 'Anchor prompt. Today is 2026-11-25.' });
    for (let i = 0; i <= CACHE_BUSTER_MAX_ENTRIES; i++) {
      extract({ system: `Filler prompt ${'x'.repeat(1 + (i % 7))}${'y'.repeat(i)}.` });
    }
    const replay = extract({ system: 'Anchor prompt. Today is 2026-11-26.' });
    expect(replay.cacheBuster).toBeUndefined();
  });

  it('starts fresh after the test reset hook', () => {
    extract({ system: 'Today is 2026-11-25.' });
    __resetCacheBusterForTests();
    expect(extract({ system: 'Today is 2026-11-26.' }).cacheBuster).toBeUndefined();
  });
});
