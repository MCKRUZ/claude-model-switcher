// DecisionLogWriter — best-effort, append-only JSONL writer with daily-or-
// size rotation, in-process byte counter (no per-append stat), bounded
// in-memory queue, and pluggable clock (for tests). Durability is
// best-effort by default; set fsync=true to fsync after each line at a
// measurable throughput cost.
//
// All disk operations are serialized on a single promise chain so that
// rotation, writes, and shutdown observe a consistent ordering. append() is
// non-blocking and returns true if the record was enqueued, false on drop.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { fsHelpers } from './_fs.js';
import type { DecisionRecord, DecisionRotationStrategy } from './types.js';
import {
  applyRetention,
  dailyFilename,
  dateStamp,
  nextSizeFilename,
  rotateRename,
  statSize,
} from './rotate.js';

const MAX_QUEUE = 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export interface DecisionLogWriter {
  /** Fire-and-forget. Returns true if accepted into the queue, false if dropped. */
  append(record: DecisionRecord): boolean;
  /** Resolves once the queue has drained to disk. */
  flush(): Promise<void>;
  /** Flush + close stream. Idempotent. */
  close(): Promise<void>;
  /** Currently active log file path. Exposed for tests/observability. */
  currentPath(): string;
  /** In-process byte count for the active file. */
  currentBytes(): number;
  /** Records that were enqueued but failed to write to disk. */
  droppedPostAccept(): number;
}

export interface DecisionLogWriterOptions {
  readonly dir: string;
  readonly rotation: DecisionRotationStrategy;
  /** Threshold for size rotation. Ignored when rotation === 'daily'. */
  readonly maxBytes: number;
  readonly retentionDays: number;
  readonly fsync: boolean;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** Override the periodic reconcile (ms). Used by tests; defaults to 5 min. */
  readonly reconcileMs?: number;
}

interface WriteJob {
  readonly kind: 'write';
  readonly line: string;
}

interface RotateJob {
  readonly kind: 'rotate';
}

type Job = WriteJob | RotateJob;

export function createDecisionLogWriter(opts: DecisionLogWriterOptions): DecisionLogWriter {
  mkdirSync(opts.dir, { recursive: true });

  const reconcileMs = opts.reconcileMs ?? RECONCILE_INTERVAL_MS;
  const queue: Job[] = [];
  let bytes = 0;
  let stream: WriteStream | null = null;
  let path = '';
  let activeDate = dateStamp(opts.clock());
  let closed = false;
  let postAcceptDrops = 0;
  let pending: Promise<void> = Promise.resolve();

  function endStream(s: WriteStream): Promise<void> {
    return new Promise((resolve) => {
      s.end(() => resolve());
    });
  }

  async function openStream(p: string): Promise<void> {
    if (stream !== null) {
      const old = stream;
      stream = null;
      await endStream(old);
    }
    path = p;
    const s = createWriteStream(p, { flags: 'a', highWaterMark: 64 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        s.removeListener('error', onErr);
        resolve();
      };
      const onErr = (err: Error): void => {
        s.removeListener('open', onOpen);
        reject(err);
      };
      s.once('open', onOpen);
      s.once('error', onErr);
    });
    s.on('error', (err) => {
      opts.logger.error({ err, event: 'decision_log_stream_error', path: p }, 'decision log stream error');
    });
    stream = s;
    // Stat happens after 'open' so an existing file's size is observed correctly.
    bytes = statSize(p);
  }

  async function performRotation(now: Date): Promise<void> {
    const stamp = dateStamp(now);
    if (opts.rotation === 'daily') {
      if (stream === null || stamp !== activeDate) {
        await openStream(join(opts.dir, dailyFilename(now)));
        activeDate = stamp;
        applyRetention(opts.dir, opts.retentionDays, now);
      }
      return;
    }
    // Size strategy.
    if (stream === null) {
      await openStream(join(opts.dir, dailyFilename(now)));
      activeDate = stamp;
      applyRetention(opts.dir, opts.retentionDays, now);
      return;
    }
    if (stamp !== activeDate) {
      await openStream(join(opts.dir, dailyFilename(now)));
      activeDate = stamp;
      applyRetention(opts.dir, opts.retentionDays, now);
      return;
    }
    if (bytes >= opts.maxBytes) {
      const target = join(opts.dir, nextSizeFilename(opts.dir, now));
      const oldPath = path;
      // Close active stream so Windows can rename the file.
      if (stream !== null) {
        const s = stream;
        stream = null;
        await endStream(s);
      }
      let rotated = true;
      try {
        rotateRename(oldPath, target);
      } catch (err) {
        rotated = false;
        opts.logger.warn({ err, event: 'decision_log_rotate_failed', src: oldPath, dst: target }, 'rotation rename failed');
      }
      await openStream(oldPath);
      // openStream re-seeds bytes from the file. If rename failed, the file
      // is still oversized — force the counter to 0 so we don't immediately
      // re-enter rotation on every subsequent append. We'll cross maxBytes
      // again organically and try once more.
      if (!rotated) bytes = 0;
      applyRetention(opts.dir, opts.retentionDays, now);
    }
  }

  async function performWrite(line: string): Promise<void> {
    await performRotation(opts.clock());
    if (stream === null) return;
    const s = stream;
    await new Promise<void>((resolve, reject) => {
      s.write(line, (err) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve();
      });
    });
    bytes += line.length;
    if (opts.fsync) {
      const fd = (s as unknown as { fd?: number }).fd;
      if (typeof fd === 'number') {
        try {
          fsHelpers.fsyncSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  }

  function enqueue(job: Job): void {
    queue.push(job);
    pending = pending
      .then(async () => {
        const j = queue.shift();
        if (j === undefined) return;
        if (j.kind === 'write') await performWrite(j.line);
        else if (j.kind === 'rotate') await performRotation(opts.clock());
      })
      .catch((err) => {
        postAcceptDrops += 1;
        opts.logger.error({ err, event: 'decision_log_internal_error' }, 'decision log internal error');
      });
  }

  function append(record: DecisionRecord): boolean {
    if (closed) {
      opts.logger.warn({ event: 'decision_log_dropped', reason: 'closed' }, 'decision log dropped (closed)');
      return false;
    }
    if (queue.length >= MAX_QUEUE) {
      opts.logger.warn({ event: 'decision_log_dropped', reason: 'queue_full' }, 'decision log dropped (queue full)');
      return false;
    }
    const line = JSON.stringify(record) + '\n';
    enqueue({ kind: 'write', line });
    return true;
  }

  function flush(): Promise<void> {
    return pending;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (reconcileTimer !== null) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    await flush();
    if (stream !== null) {
      const s = stream;
      stream = null;
      await endStream(s);
    }
  }

  // Periodic reconcile to correct counter drift.
  let reconcileTimer: NodeJS.Timeout | null = setInterval(() => {
    if (path === '') return;
    bytes = statSize(path);
  }, reconcileMs);
  reconcileTimer.unref?.();

  // Eagerly open the initial stream so currentPath/currentBytes are valid
  // and the first read-after-flush sees the file on disk.
  enqueue({ kind: 'rotate' });

  return {
    append,
    flush,
    close,
    currentPath: () => path,
    currentBytes: () => bytes,
    droppedPostAccept: () => postAcceptDrops,
  };
}
