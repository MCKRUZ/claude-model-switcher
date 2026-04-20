import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import { createDecisionLogWriter, type DecisionLogWriter } from '../../src/decisions/log.js';
import type { DecisionRecord } from '../../src/decisions/types.js';
import { readDecisions } from '../../src/decisions/reader.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ccmux-dl-'));
}

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    timestamp: '2026-04-17T00:00:00.000Z',
    session_id: 'sess-1',
    request_hash: 'rh-1',
    extracted_signals: { messageCount: 1 },
    policy_result: { rule_id: 'r1' },
    classifier_result: null,
    sticky_hit: false,
    chosen_model: 'claude-haiku-4-5-20251001',
    chosen_by: 'policy',
    forwarded_model: 'claude-haiku-4-5-20251001',
    upstream_latency_ms: 0,
    usage: null,
    cost_estimate_usd: null,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

function defaultOpts(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    dir,
    rotation: 'daily' as const,
    maxBytes: 10_000,
    retentionDays: 30,
    fsync: false,
    logger: silentLogger(),
    clock: () => new Date('2026-04-17T00:00:00Z'),
    ...overrides,
  };
}

let writer: DecisionLogWriter | null = null;

afterEach(async () => {
  if (writer !== null) {
    await writer.close();
    writer = null;
  }
  vi.restoreAllMocks();
});

describe('DecisionLogWriter — core writes', () => {
  it('writes one JSONL line per record matching the input shape', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir, { maxBytes: 1024 * 1024 }));
    writer.append(mkRecord({ session_id: 'a' }));
    writer.append(mkRecord({ session_id: 'b' }));
    await writer.flush();
    const lines = readFileSync(writer.currentPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ session_id: 'a' });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ session_id: 'b' });
  });

  it('records the actual forwarded model, not the requested one', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir, { maxBytes: 1024 * 1024 }));
    writer.append(mkRecord({
      chosen_model: 'claude-opus-4-7',
      forwarded_model: 'claude-haiku-4-5-20251001',
    }));
    await writer.flush();
    const line = readFileSync(writer.currentPath(), 'utf8').trim();
    const parsed = JSON.parse(line) as DecisionRecord;
    expect(parsed.forwarded_model).toBe('claude-haiku-4-5-20251001');
    expect(parsed.chosen_model).toBe('claude-opus-4-7');
  });
});

describe('DecisionLogWriter — rotation', () => {
  it('does not call statSync on the hot append path (in-process byte counter)', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir, {
      rotation: 'size',
      maxBytes: 1024 * 1024,
    }));
    await writer.flush();
    const { fsHelpers } = await import('../../src/decisions/_fs.js');
    const spy = vi.spyOn(fsHelpers, 'statSync');
    for (let i = 0; i < 50; i += 1) {
      writer.append(mkRecord({ session_id: `s${i}` }));
    }
    await writer.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('triggers size-based rotation when the byte counter crosses maxBytes', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir, {
      rotation: 'size',
      maxBytes: 200,
    }));
    for (let i = 0; i < 5; i += 1) {
      writer.append(mkRecord({ session_id: `s${i}` }));
      await writer.flush();
    }
    const entries = readdirSync(dir).filter((f) => f.startsWith('decisions-')).sort();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e) => /^decisions-\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/.test(e))).toBe(true);
  });

  it('seeds the byte counter from the file size on startup for an existing file', async () => {
    const dir = tmpDir();
    const date = new Date('2026-04-17T12:00:00Z');
    const seedPath = join(dir, `decisions-2026-04-17.jsonl`);
    writeFileSync(seedPath, 'x'.repeat(500));
    writer = createDecisionLogWriter(defaultOpts(dir, { clock: () => date }));
    await writer.flush();
    expect(writer.currentBytes()).toBe(500);
  });

  it('rotates when the UTC date changes (daily strategy)', async () => {
    const dir = tmpDir();
    let now = new Date('2026-04-17T23:59:00Z');
    writer = createDecisionLogWriter(defaultOpts(dir, { clock: () => now }));
    writer.append(mkRecord({ session_id: 'pre-midnight' }));
    await writer.flush();
    const firstPath = writer.currentPath();
    now = new Date('2026-04-18T00:01:00Z');
    writer.append(mkRecord({ session_id: 'post-midnight' }));
    await writer.flush();
    const secondPath = writer.currentPath();
    expect(secondPath).not.toBe(firstPath);
    expect(readFileSync(firstPath, 'utf8')).toMatch(/pre-midnight/);
    expect(readFileSync(secondPath, 'utf8')).toMatch(/post-midnight/);
  });
});

describe('DecisionLogWriter — backpressure and lifecycle', () => {
  it('drops records with reason=queue_full when MAX_QUEUE is exceeded', async () => {
    const dir = tmpDir();
    const warns: unknown[] = [];
    const logger: Logger = pino({ level: 'silent' });
    (logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warns.push(a); };
    writer = createDecisionLogWriter(defaultOpts(dir, {
      maxBytes: 10_000_000,
      logger,
      clock: () => new Date('2026-04-17T12:00:00Z'),
    }));
    let drops = 0;
    for (let i = 0; i < 1500; i += 1) {
      const ok = writer.append(mkRecord({ session_id: `s${i}` }));
      if (!ok) drops += 1;
    }
    expect(drops).toBeGreaterThan(0);
    expect(warns.some((a) => JSON.stringify(a).includes('queue_full'))).toBe(true);
    await writer.flush();
  });

  it('drops records with reason=closed after close()', async () => {
    const dir = tmpDir();
    const warns: unknown[] = [];
    const logger: Logger = pino({ level: 'silent' });
    (logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warns.push(a); };
    writer = createDecisionLogWriter(defaultOpts(dir, {
      maxBytes: 10_000_000,
      logger,
      clock: () => new Date('2026-04-17T12:00:00Z'),
    }));
    await writer.close();
    const accepted = writer.append(mkRecord());
    expect(accepted).toBe(false);
    expect(warns.some((a) => JSON.stringify(a).includes('"reason":"closed"'))).toBe(true);
    writer = null;
  });

  it('does not fsync on each append by default', async () => {
    const dir = tmpDir();
    const { fsHelpers } = await import('../../src/decisions/_fs.js');
    const spy = vi.spyOn(fsHelpers, 'fsyncSync');
    writer = createDecisionLogWriter(defaultOpts(dir, {
      clock: () => new Date(2026, 3, 17, 12),
    }));
    writer.append(mkRecord());
    await writer.flush();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('DecisionLogWriter — reader', () => {
  it('reader yields records in chronological order across multiple files', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir, {
      rotation: 'size',
      maxBytes: 200,
      clock: () => new Date(2026, 3, 17, 12),
    }));
    for (let i = 0; i < 5; i += 1) {
      writer.append(mkRecord({ session_id: `s${i}` }));
      await writer.flush();
    }
    await writer.close();
    writer = null;
    const out: string[] = [];
    for await (const r of readDecisions(dir)) {
      out.push(r.session_id);
    }
    expect(out).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('reader limit caps the number of yielded records', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir, {
      clock: () => new Date(2026, 3, 17, 12),
    }));
    for (let i = 0; i < 5; i += 1) writer.append(mkRecord({ session_id: `s${i}` }));
    await writer.flush();
    await writer.close();
    writer = null;
    const out: string[] = [];
    for await (const r of readDecisions(dir, { limit: 2 })) out.push(r.session_id);
    expect(out).toHaveLength(2);
  });
});

describe('DecisionLogWriter — serialization contracts', () => {
  it('golden record round-trip is byte-for-byte stable for a fixed input', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir));
    const record = mkRecord({
      timestamp: '2026-04-17T14:00:00.000Z',
      session_id: 'sess-golden',
      request_hash: 'rh-golden',
      chosen_model: 'claude-haiku-4-5-20251001',
      forwarded_model: 'claude-haiku-4-5-20251001',
    });
    writer.append(record);
    await writer.flush();
    const onDisk = readFileSync(writer.currentPath(), 'utf8');
    expect(onDisk).toBe(JSON.stringify(record) + '\n');
  });

  // Tag for §17 contract: usage = null if upstream stream errors.
  it('records usage=null and cost=null when upstream usage is absent', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir));
    writer.append(mkRecord({ usage: null, cost_estimate_usd: null }));
    await writer.flush();
    const parsed = JSON.parse(readFileSync(writer.currentPath(), 'utf8').trim()) as DecisionRecord;
    expect(parsed.usage).toBeNull();
    expect(parsed.cost_estimate_usd).toBeNull();
  });

  // Defensive: file size on disk must equal what we wrote (no half-written lines).
  it('writes complete lines (newline-terminated) to disk', async () => {
    const dir = tmpDir();
    writer = createDecisionLogWriter(defaultOpts(dir));
    writer.append(mkRecord());
    await writer.flush();
    const size = statSync(writer.currentPath()).size;
    const text = readFileSync(writer.currentPath(), 'utf8');
    expect(size).toBe(Buffer.byteLength(text));
    expect(text.endsWith('\n')).toBe(true);
  });
});
