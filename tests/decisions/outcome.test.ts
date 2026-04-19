import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import {
  createOutcomeTagger,
  type OutcomeTagger,
  type OutcomeTaggerInput,
} from '../../src/decisions/outcome.js';

function tmpLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'ccmux-outcome-'));
}

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

function rec(over: Partial<OutcomeTaggerInput> & { ts: string; requestHash: string; sessionId: string }): OutcomeTaggerInput {
  return { frustration: false, ...over };
}

interface InMemoryDeps {
  appended: { path: string; line: string }[];
  appendLine: (path: string, line: string) => Promise<void>;
  readLines: (path: string) => AsyncIterable<string>;
  files: Map<string, string>;
  logger: Logger;
  now: () => number;
}

function makeDeps(initial: Map<string, string> = new Map()): InMemoryDeps {
  const files = new Map(initial);
  const appended: { path: string; line: string }[] = [];
  return {
    appended,
    files,
    logger: silentLogger(),
    now: () => Date.now(),
    appendLine: async (path, line) => {
      appended.push({ path, line });
      files.set(path, (files.get(path) ?? '') + line);
    },
    readLines: (path) => {
      const content = files.get(path) ?? '';
      const lines = content.length === 0 ? [] : content.split('\n').filter((l) => l.length > 0);
      return (async function* () {
        for (const l of lines) yield l;
      })();
    },
  };
}

let tagger: OutcomeTagger | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (tagger !== null) {
    await tagger.stop();
    tagger = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('outcome tagger', () => {
  it('tags the prior turn "continued" when a new turn arrives in the same session', async () => {
    const dir = tmpLogDir();
    const deps = makeDeps();
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1' }));
    tagger.ingest(rec({ ts: '2026-04-17T10:00:30Z', requestHash: 'h2', sessionId: 's1' }));
    await tagger.flush();
    expect(deps.appended).toHaveLength(1);
    const parsed = JSON.parse(deps.appended[0]!.line) as { requestHash: string; tag: string };
    expect(parsed).toMatchObject({ requestHash: 'h1', tag: 'continued' });
  });

  it('tags "retried" when the same requestHash repeats within retryWindowSec', async () => {
    const dir = tmpLogDir();
    const deps = makeDeps();
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'hX', sessionId: 's1' }));
    tagger.ingest(rec({ ts: '2026-04-17T10:00:30Z', requestHash: 'hX', sessionId: 's1' }));
    await tagger.flush();
    expect(deps.appended.some((a) => a.line.includes('"tag":"retried"'))).toBe(true);
    expect(deps.appended.filter((a) => JSON.parse(a.line).requestHash === 'hX')).toHaveLength(1);
  });

  it('does NOT tag "retried" when the same requestHash repeats AFTER retryWindowSec', async () => {
    const dir = tmpLogDir();
    const deps = makeDeps();
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'hY', sessionId: 's1' }));
    tagger.ingest(rec({ ts: '2026-04-17T10:05:00Z', requestHash: 'hY', sessionId: 's1' }));
    await tagger.flush();
    expect(deps.appended.every((a) => !a.line.includes('"tag":"retried"'))).toBe(true);
    expect(deps.appended.some((a) => a.line.includes('"tag":"continued"'))).toBe(true);
  });

  it('tags "frustration_next_turn" when the follow-up turn has frustration=true', async () => {
    const dir = tmpLogDir();
    const deps = makeDeps();
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1', frustration: false }));
    tagger.ingest(rec({ ts: '2026-04-17T10:00:30Z', requestHash: 'h2', sessionId: 's1', frustration: true }));
    await tagger.flush();
    expect(deps.appended).toHaveLength(1);
    expect(JSON.parse(deps.appended[0]!.line)).toMatchObject({ requestHash: 'h1', tag: 'frustration_next_turn' });
  });

  it('tags "abandoned" when no follow-up occurs within idleTtlSec', async () => {
    const dir = tmpLogDir();
    let nowMs = Date.parse('2026-04-17T10:00:00Z');
    const deps = makeDeps();
    deps.now = () => nowMs;
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'lone', sessionId: 's1' }));
    nowMs += 901_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await tagger.flush();
    expect(deps.appended.some((a) => JSON.parse(a.line).requestHash === 'lone' && JSON.parse(a.line).tag === 'abandoned')).toBe(true);
  });

  it('writes one tag per requestHash (first-write wins)', async () => {
    const dir = tmpLogDir();
    const deps = makeDeps();
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1' }));
    tagger.ingest(rec({ ts: '2026-04-17T10:00:10Z', requestHash: 'h2', sessionId: 's1' })); // tags h1 continued
    tagger.ingest(rec({ ts: '2026-04-17T10:00:20Z', requestHash: 'h1', sessionId: 's2' })); // would imply retried, but h1 already tagged
    await tagger.flush();
    const h1Lines = deps.appended.filter((a) => JSON.parse(a.line).requestHash === 'h1');
    expect(h1Lines).toHaveLength(1);
  });

  it('rebuilds the tagged-hash set from existing outcomes.jsonl on startup', async () => {
    const dir = tmpLogDir();
    const sidecarPath = join(dir, 'outcomes.jsonl');
    const seeded = new Map([[sidecarPath, JSON.stringify({ requestHash: 'preTagged', sessionId: 's0', tag: 'continued', ts: '2026-04-16T00:00:00Z' }) + '\n']]);
    const deps = makeDeps(seeded);
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'preTagged', sessionId: 's1' }));
    tagger.ingest(rec({ ts: '2026-04-17T10:00:10Z', requestHash: 'h2', sessionId: 's1' }));
    await tagger.flush();
    expect(deps.appended.some((a) => JSON.parse(a.line).requestHash === 'preTagged')).toBe(false);
  });

  it('never throws into the caller; logs warnings on internal errors', async () => {
    const dir = tmpLogDir();
    const warns: unknown[] = [];
    const deps = makeDeps();
    (deps.logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warns.push(a); };
    deps.appendLine = async () => { throw new Error('disk gone'); };
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await tagger.start();
    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1' }));
    tagger.ingest(rec({ ts: '2026-04-17T10:00:10Z', requestHash: 'h2', sessionId: 's1' }));
    await tagger.flush();
    expect(warns.length).toBeGreaterThan(0);
  });

  it('start() does not throw when readLines fails during seed', async () => {
    const dir = tmpLogDir();
    const warns: unknown[] = [];
    const deps = makeDeps();
    (deps.logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warns.push(a); };
    deps.readLines = (_path: string) => {
      return (async function* () {
        throw new Error('cannot read sidecar');
      })();
    };
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      deps,
    );
    await expect(tagger.start()).resolves.toBeUndefined();
    expect(warns.some((a) => JSON.stringify(a).includes('outcome_seed_failed'))).toBe(true);
  });

  it('end-to-end: reads decision JSONL from a real file, writes outcomes sidecar', async () => {
    const dir = tmpLogDir();
    const decisionPath = join(dir, 'decisions-2026-04-17.jsonl');
    const sidecarPath = join(dir, 'outcomes.jsonl');
    writeFileSync(decisionPath, [
      JSON.stringify({ ts: '2026-04-17T10:00:00Z', requestHash: 'r1', sessionId: 's1', signals: { frustration: false } }),
      JSON.stringify({ ts: '2026-04-17T10:00:10Z', requestHash: 'r2', sessionId: 's1', signals: { frustration: false } }),
    ].join('\n') + '\n', 'utf8');

    // Use real fs deps for this case.
    const { promises: fsp } = await import('node:fs');
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const realDeps = {
      now: () => Date.now(),
      logger: silentLogger(),
      appendLine: async (path: string, line: string) => { await fsp.appendFile(path, line, 'utf8'); },
      readLines: (path: string): AsyncIterable<string> => {
        if (!existsSync(path)) {
          return (async function* () { /* empty */ })();
        }
        const stream = createReadStream(path, { encoding: 'utf8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        return rl;
      },
    };
    tagger = createOutcomeTagger(
      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
      realDeps,
    );
    await tagger.start();
    // Manually feed the records (the file-tail wrapper lives elsewhere).
    tagger.ingest({ ts: '2026-04-17T10:00:00Z', requestHash: 'r1', sessionId: 's1', frustration: false });
    tagger.ingest({ ts: '2026-04-17T10:00:10Z', requestHash: 'r2', sessionId: 's1', frustration: false });
    await tagger.stop();
    tagger = null;
    const sidecar = readFileSync(sidecarPath, 'utf8').trim();
    expect(sidecar).toMatch(/"requestHash":"r1"/);
    expect(sidecar).toMatch(/"tag":"continued"/);
  });
});
