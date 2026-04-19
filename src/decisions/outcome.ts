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

export function createOutcomeTagger(
  config: OutcomeTaggerConfig,
  deps: OutcomeTaggerDeps,
): OutcomeTagger {
  const sidecarPath = join(config.logDir, 'outcomes.jsonl');
  const tagged = new Set<string>();
  const lastSeen = new Map<string, SessionEntry>();
  const recentHashes = new Map<string, { tsMs: number; sessionId: string }>();
  let timer: NodeJS.Timeout | null = null;
  let pending: Promise<void> = Promise.resolve();
  let started = false;
  let stopped = false;

  function emitTag(requestHash: string, sessionId: string, tag: OutcomeTag, ts: string): void {
    if (tagged.has(requestHash)) return;
    tagged.add(requestHash);
    const line = JSON.stringify({ requestHash, sessionId, tag, ts }) + '\n';
    pending = pending
      .then(() => deps.appendLine(sidecarPath, line))
      .catch((err) => {
        deps.logger.warn({ err, event: 'outcome_tag_write_failed', requestHash, tag }, 'outcome tag write failed');
      });
  }

  function pruneRecent(nowMs: number): void {
    const cutoff = nowMs - config.retryWindowSec * 2 * 1000;
    for (const [hash, entry] of recentHashes) {
      if (entry.tsMs < cutoff) recentHashes.delete(hash);
    }
  }

  function ingest(record: OutcomeTaggerInput): void {
    if (stopped) return;
    try {
      const tsMs = Date.parse(record.ts);
      if (Number.isNaN(tsMs)) {
        deps.logger.warn({ event: 'outcome_skip_bad_timestamp', ts: record.ts }, 'skipping record with unparseable timestamp');
        return;
      }
      pruneRecent(tsMs);

      const priorHash = recentHashes.get(record.requestHash);
      if (priorHash !== undefined && tsMs - priorHash.tsMs <= config.retryWindowSec * 1000) {
        // Tag annotates the prior decision, so attribute to its sessionId.
        emitTag(record.requestHash, priorHash.sessionId, 'retried', record.ts);
      } else {
        const prior = lastSeen.get(record.sessionId);
        if (prior !== undefined) {
          if (prior.frustration !== true && record.frustration === true) {
            emitTag(prior.requestHash, record.sessionId, 'frustration_next_turn', record.ts);
          } else {
            emitTag(prior.requestHash, record.sessionId, 'continued', record.ts);
          }
        }
      }

      lastSeen.set(record.sessionId, {
        requestHash: record.requestHash,
        tsMs,
        frustration: record.frustration,
      });
      recentHashes.set(record.requestHash, { tsMs, sessionId: record.sessionId });
    } catch (err) {
      deps.logger.warn({ err, event: 'outcome_ingest_error' }, 'outcome tagger ingest error');
    }
  }

  function sweepIdle(): void {
    try {
      const nowMs = deps.now();
      const cutoff = nowMs - config.idleTtlSec * 1000;
      for (const [sessionId, prior] of lastSeen) {
        if (prior.tsMs < cutoff) {
          if (!tagged.has(prior.requestHash)) {
            emitTag(prior.requestHash, sessionId, 'abandoned', new Date(nowMs).toISOString());
          }
          lastSeen.delete(sessionId);
        }
      }
    } catch (err) {
      deps.logger.warn({ err, event: 'outcome_sweep_error' }, 'outcome sweep error');
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    try {
      for await (const line of deps.readLines(sidecarPath)) {
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as { requestHash?: unknown };
          if (typeof parsed.requestHash === 'string') tagged.add(parsed.requestHash);
        } catch {
          // skip malformed line
        }
      }
    } catch (err) {
      deps.logger.warn({ err, event: 'outcome_seed_failed', path: sidecarPath }, 'outcome sidecar seed failed');
    }
    timer = setInterval(sweepIdle, config.tailIntervalMs);
    timer.unref?.();
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    await pending;
  }

  function flush(): Promise<void> {
    return pending;
  }

  return { start, ingest, flush, stop };
}
