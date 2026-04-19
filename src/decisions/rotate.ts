// Rotation policies for the decision-log writer.
//
// Daily rotation: the active filename is decisions-YYYY-MM-DD.jsonl. When the
// local-date component changes, the next append opens a new file (no rename
// needed, since the date is in the filename).
//
// Size rotation: when the in-process byte counter reaches maxBytes, we rotate
// the active file to decisions-YYYY-MM-DD.<n>.jsonl with n monotonically
// increasing for the same day; the active filename (suffix 0) keeps writing.
// On Windows, fs.renameSync may fail with EBUSY/EPERM if the file is held;
// we fall back to copy+truncate so the active stream can keep going.
//
// Retention: dates are parsed from the filename — we never trust mtime.

import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fsHelpers } from './_fs.js';

const DAILY_RE = /^decisions-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;

// Daily rollover uses UTC so deployments in different timezones produce the
// same filename for the same wall-clock instant. Equivalent to
// date.toISOString().slice(0, 10).
export function dateStamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dailyFilename(date: Date): string {
  return `decisions-${dateStamp(date)}.jsonl`;
}

export function sizeFilename(date: Date, n: number): string {
  return `decisions-${dateStamp(date)}.${n}.jsonl`;
}

export interface ParsedLogName {
  readonly date: string;
  readonly suffix: number;
}

export function parseLogFilename(name: string): ParsedLogName | null {
  const m = DAILY_RE.exec(name);
  if (m === null) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    suffix: m[4] === undefined ? 0 : Number.parseInt(m[4], 10),
  };
}

/**
 * Returns the next size-rotation filename for `date` not already on disk.
 * Inspects the directory, finds the max suffix for that date, returns +1.
 */
export function nextSizeFilename(dir: string, date: Date): string {
  let max = 0;
  const stamp = dateStamp(date);
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const parsed = parseLogFilename(entry);
    if (parsed === null) continue;
    if (parsed.date !== stamp) continue;
    if (parsed.suffix > max) max = parsed.suffix;
  }
  return sizeFilename(date, max + 1);
}

/**
 * Atomic rename with a copy+truncate fallback for Windows EBUSY/EPERM cases
 * where the source file is still being held by the writer.
 */
export function rotateRename(src: string, dst: string): void {
  try {
    fsHelpers.renameSync(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
  }
  fsHelpers.copyFileSync(src, dst);
  fsHelpers.truncateSync(src, 0);
}

/**
 * Deletes log files whose filename-date is older than `retentionDays` from
 * `now`. Files we cannot parse are left alone. mtime is intentionally
 * ignored — the filename is the source of truth.
 */
export function applyRetention(dir: string, retentionDays: number, now: Date): readonly string[] {
  if (retentionDays <= 0) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStamp = dateStamp(cutoff);
  const removed: string[] = [];
  for (const entry of entries) {
    const parsed = parseLogFilename(entry);
    if (parsed === null) continue;
    if (parsed.date < cutoffStamp) {
      const full = join(dir, entry);
      try {
        unlinkSync(full);
        removed.push(entry);
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

/** Best-effort byte counter seed. Returns 0 if the file does not exist. */
export function statSize(path: string): number {
  try {
    return fsHelpers.statSync(path).size;
  } catch {
    return 0;
  }
}

