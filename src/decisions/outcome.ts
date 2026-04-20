// Outcome tagger — passive, post-hoc annotation of decision records with a
// session-outcome label written to outcomes.jsonl. Never blocks the proxy
// path. First tag wins per requestHash, so re-running over the same log on
// startup is a no-op. Time and I/O are injected so tests use fake timers and
// in-memory stores.
//
// Tag values:
//   continued              — next turn in the same session is a new prompt
//   retried                — same requestHash repeats within retryWindowSec
//   frustration_next_turn  — follow-up turn flips frustration false → true
//   abandoned              — no follow-up turn within idleTtlSec

import type { Logger } from 'pino';
import { join } from 'node:path';

export type OutcomeTag = 'continued' | 'retried' | 'frustration_next_turn' | 'abandoned';

export interface OutcomeTaggerConfig {
  readonly logDir: string;
  readonly retryWindowSec: number;
  readonly idleTtlSec: number;
  readonly tailIntervalMs: number;
}

export interface OutcomeTaggerInput {
  readonly ts: string;            // ISO timestamp
  readonly requestHash: string;
  readonly sessionId: string;
  readonly frustration: boolean | null;
}

export interface OutcomeTaggerDeps {
  now(): number;
  appendLine(path: string, line: string): Promise<void>;
  readLines(path: string): AsyncIterable<string>;
  logger: Logger;
}

export interface OutcomeTagger {
  start(): Promise<void>;
  ingest(record: OutcomeTaggerInput): void;
  /** Resolves once all queued sidecar writes have completed. Mostly for tests. */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

interface SessionEntry {
  readonly requestHash: string;
  readonly tsMs: number;
  readonly frustration: boolean | null;
}

interface TaggerState {
  readonly sidecarPath: string;
  readonly tagged: Set<string>;
  readonly lastSeen: Map<string, SessionEntry>;
  readonly recentHashes: Map<string, { tsMs: number; sessionId: string }>;
  timer: NodeJS.Timeout | null;
  pending: Promise<void>;
  started: boolean;
  stopped: boolean;
}

function emitTag(
  state: TaggerState,
  deps: OutcomeTaggerDeps,
  requestHash: string,
  sessionId: string,
  tag: OutcomeTag,
  ts: string,
): void {
  if (state.tagged.has(requestHash)) return;
  state.tagged.add(requestHash);
  const line = JSON.stringify({ requestHash, sessionId, tag, ts }) + '\n';
  state.pending = state.pending
    .then(() => deps.appendLine(state.sidecarPath, line))
    .catch((err) => {
      deps.logger.warn({ err, event: 'outcome_tag_write_failed', requestHash, tag }, 'outcome tag write failed');
    });
}

function pruneRecent(state: TaggerState, config: OutcomeTaggerConfig, nowMs: number): void {
  const cutoff = nowMs - config.retryWindowSec * 2 * 1000;
  for (const [hash, entry] of state.recentHashes) {
    if (entry.tsMs < cutoff) state.recentHashes.delete(hash);
  }
}

function classifyAndTag(
  state: TaggerState,
  config: OutcomeTaggerConfig,
  deps: OutcomeTaggerDeps,
  record: OutcomeTaggerInput,
  tsMs: number,
): void {
  const priorHash = state.recentHashes.get(record.requestHash);
  if (priorHash !== undefined && tsMs - priorHash.tsMs <= config.retryWindowSec * 1000) {
    emitTag(state, deps, record.requestHash, priorHash.sessionId, 'retried', record.ts);
  } else {
    const prior = state.lastSeen.get(record.sessionId);
    if (prior !== undefined) {
      if (prior.frustration !== true && record.frustration === true) {
        emitTag(state, deps, prior.requestHash, record.sessionId, 'frustration_next_turn', record.ts);
      } else {
        emitTag(state, deps, prior.requestHash, record.sessionId, 'continued', record.ts);
      }
    }
  }
}

function handleIngest(
  state: TaggerState,
  config: OutcomeTaggerConfig,
  deps: OutcomeTaggerDeps,
  record: OutcomeTaggerInput,
): void {
  if (state.stopped) return;
  try {
    const tsMs = Date.parse(record.ts);
    if (Number.isNaN(tsMs)) {
      deps.logger.warn({ event: 'outcome_skip_bad_timestamp', ts: record.ts }, 'skipping record with unparseable timestamp');
      return;
    }
    pruneRecent(state, config, tsMs);
    classifyAndTag(state, config, deps, record, tsMs);
    state.lastSeen.set(record.sessionId, {
      requestHash: record.requestHash,
      tsMs,
      frustration: record.frustration,
    });
    state.recentHashes.set(record.requestHash, { tsMs, sessionId: record.sessionId });
  } catch (err) {
    deps.logger.warn({ err, event: 'outcome_ingest_error' }, 'outcome tagger ingest error');
  }
}

function sweepIdle(state: TaggerState, config: OutcomeTaggerConfig, deps: OutcomeTaggerDeps): void {
  try {
    const nowMs = deps.now();
    const cutoff = nowMs - config.idleTtlSec * 1000;
    for (const [sessionId, prior] of state.lastSeen) {
      if (prior.tsMs < cutoff) {
        if (!state.tagged.has(prior.requestHash)) {
          emitTag(state, deps, prior.requestHash, sessionId, 'abandoned', new Date(nowMs).toISOString());
        }
        state.lastSeen.delete(sessionId);
      }
    }
  } catch (err) {
    deps.logger.warn({ err, event: 'outcome_sweep_error' }, 'outcome sweep error');
  }
}

async function seedFromExistingLog(state: TaggerState, deps: OutcomeTaggerDeps): Promise<void> {
  try {
    for await (const line of deps.readLines(state.sidecarPath)) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { requestHash?: unknown };
        if (typeof parsed.requestHash === 'string') state.tagged.add(parsed.requestHash);
      } catch {
        // skip malformed line
      }
    }
  } catch (err) {
    deps.logger.warn({ err, event: 'outcome_seed_failed', path: state.sidecarPath }, 'outcome sidecar seed failed');
  }
}

export function createOutcomeTagger(
  config: OutcomeTaggerConfig,
  deps: OutcomeTaggerDeps,
): OutcomeTagger {
  const state: TaggerState = {
    sidecarPath: join(config.logDir, 'outcomes.jsonl'),
    tagged: new Set<string>(),
    lastSeen: new Map<string, SessionEntry>(),
    recentHashes: new Map<string, { tsMs: number; sessionId: string }>(),
    timer: null,
    pending: Promise.resolve(),
    started: false,
    stopped: false,
  };

  async function start(): Promise<void> {
    if (state.started) return;
    state.started = true;
    await seedFromExistingLog(state, deps);
    state.timer = setInterval(() => sweepIdle(state, config, deps), config.tailIntervalMs);
    state.timer.unref?.();
  }

  async function stop(): Promise<void> {
    if (state.stopped) return;
    state.stopped = true;
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    await state.pending;
  }

  return {
    start,
    ingest: (record) => handleIngest(state, config, deps, record),
    flush: () => state.pending,
    stop,
  };
}
