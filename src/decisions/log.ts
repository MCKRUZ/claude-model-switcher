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

interface WriterState {
  bytes: number;
  stream: WriteStream | null;
  path: string;
  activeDate: string;
  closed: boolean;
  postAcceptDrops: number;
  pending: Promise<void>;
  reconcileTimer: NodeJS.Timeout | null;
  readonly queue: Job[];
}

function endStream(s: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    s.end(() => resolve());
  });
}

async function openStream(state: WriterState, p: string, logger: Logger): Promise<void> {
  if (state.stream !== null) {
    const old = state.stream;
    state.stream = null;
    await endStream(old);
  }
  state.path = p;
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
    logger.error({ err, event: 'decision_log_stream_error', path: p }, 'decision log stream error');
  });
  state.stream = s;
  state.bytes = statSize(p);
}

async function performDailyRotation(state: WriterState, now: Date, opts: DecisionLogWriterOptions): Promise<void> {
  const stamp = dateStamp(now);
  if (state.stream === null || stamp !== state.activeDate) {
    await openStream(state, join(opts.dir, dailyFilename(now)), opts.logger);
    state.activeDate = stamp;
    applyRetention(opts.dir, opts.retentionDays, now);
  }
}

async function performSizeRotationOverflow(state: WriterState, now: Date, opts: DecisionLogWriterOptions): Promise<void> {
  const target = join(opts.dir, nextSizeFilename(opts.dir, now));
  const oldPath = state.path;
  if (state.stream !== null) {
    const s = state.stream;
    state.stream = null;
    await endStream(s);
  }
  let rotated = true;
  try {
    rotateRename(oldPath, target);
  } catch (err) {
    rotated = false;
    opts.logger.warn({ err, event: 'decision_log_rotate_failed', src: oldPath, dst: target }, 'rotation rename failed');
  }
  await openStream(state, oldPath, opts.logger);
  if (!rotated) state.bytes = 0;
  applyRetention(opts.dir, opts.retentionDays, now);
}

async function performSizeRotation(state: WriterState, now: Date, opts: DecisionLogWriterOptions): Promise<void> {
  const stamp = dateStamp(now);
  if (state.stream === null || stamp !== state.activeDate) {
    await openStream(state, join(opts.dir, dailyFilename(now)), opts.logger);
    state.activeDate = stamp;
    applyRetention(opts.dir, opts.retentionDays, now);
    return;
  }
  if (state.bytes >= opts.maxBytes) {
    await performSizeRotationOverflow(state, now, opts);
  }
}

async function performRotation(state: WriterState, now: Date, opts: DecisionLogWriterOptions): Promise<void> {
  if (opts.rotation === 'daily') {
    await performDailyRotation(state, now, opts);
  } else {
    await performSizeRotation(state, now, opts);
  }
}

async function performWrite(state: WriterState, line: string, opts: DecisionLogWriterOptions): Promise<void> {
  await performRotation(state, opts.clock(), opts);
  if (state.stream === null) return;
  const s = state.stream;
  await new Promise<void>((resolve, reject) => {
    s.write(line, (err) => {
      if (err !== null && err !== undefined) reject(err);
      else resolve();
    });
  });
  state.bytes += line.length;
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

function enqueue(state: WriterState, job: Job, opts: DecisionLogWriterOptions): void {
  state.queue.push(job);
  state.pending = state.pending
    .then(async () => {
      const j = state.queue.shift();
      if (j === undefined) return;
      if (j.kind === 'write') await performWrite(state, j.line, opts);
      else if (j.kind === 'rotate') await performRotation(state, opts.clock(), opts);
    })
    .catch((err) => {
      state.postAcceptDrops += 1;
      opts.logger.error({ err, event: 'decision_log_internal_error' }, 'decision log internal error');
    });
}

function appendRecord(state: WriterState, record: DecisionRecord, opts: DecisionLogWriterOptions): boolean {
  if (state.closed) {
    opts.logger.warn({ event: 'decision_log_dropped', reason: 'closed' }, 'decision log dropped (closed)');
    return false;
  }
  if (state.queue.length >= MAX_QUEUE) {
    opts.logger.warn({ event: 'decision_log_dropped', reason: 'queue_full' }, 'decision log dropped (queue full)');
    return false;
  }
  enqueue(state, { kind: 'write', line: JSON.stringify(record) + '\n' }, opts);
  return true;
}

async function closeWriter(state: WriterState): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  if (state.reconcileTimer !== null) {
    clearInterval(state.reconcileTimer);
    state.reconcileTimer = null;
  }
  await state.pending;
  if (state.stream !== null) {
    const s = state.stream;
    state.stream = null;
    await endStream(s);
  }
}

function initState(opts: DecisionLogWriterOptions): WriterState {
  return {
    bytes: 0,
    stream: null,
    path: '',
    activeDate: dateStamp(opts.clock()),
    closed: false,
    postAcceptDrops: 0,
    pending: Promise.resolve(),
    reconcileTimer: null,
    queue: [],
  };
}

function startReconcileTimer(state: WriterState, reconcileMs: number): void {
  state.reconcileTimer = setInterval(() => {
    if (state.path === '') return;
    state.bytes = statSize(state.path);
  }, reconcileMs);
  state.reconcileTimer.unref?.();
}

export function createDecisionLogWriter(opts: DecisionLogWriterOptions): DecisionLogWriter {
  mkdirSync(opts.dir, { recursive: true });

  const state = initState(opts);

  startReconcileTimer(state, opts.reconcileMs ?? RECONCILE_INTERVAL_MS);
  enqueue(state, { kind: 'rotate' }, opts);

  return {
    append: (record: DecisionRecord) => appendRecord(state, record, opts),
    flush: () => state.pending,
    close: () => closeWriter(state),
    currentPath: () => state.path,
    currentBytes: () => state.bytes,
    droppedPostAccept: () => state.postAcceptDrops,
  };
}
