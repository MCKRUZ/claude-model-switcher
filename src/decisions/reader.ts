// Streaming reader for decision JSONL files. Used by §17 (dashboard-server)
// and §15 (report-cli) to paginate without loading whole files into memory.
// Iterates files in chronological order (filename date asc, suffix asc).

import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DecisionRecord } from './types.js';
import { parseLogFilename } from './rotate.js';

export interface ReadDecisionsOptions {
  /** ISO timestamp inclusive lower bound. */
  readonly since?: string;
  /** Max records to yield total. */
  readonly limit?: number;
}

export async function* readDecisions(
  dir: string,
  opts: ReadDecisionsOptions = {},
): AsyncIterableIterator<DecisionRecord> {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const files = entries
    .map((name) => ({ name, parsed: parseLogFilename(name) }))
    .filter((e): e is { name: string; parsed: NonNullable<ReturnType<typeof parseLogFilename>> } => e.parsed !== null)
    .sort((a, b) => {
      if (a.parsed.date !== b.parsed.date) return a.parsed.date < b.parsed.date ? -1 : 1;
      // Within a day: rotated files (suffix 1..N) hold older lines in
      // order; the active file (suffix 0) is the newest and must come last.
      const ax = a.parsed.suffix === 0 ? Number.MAX_SAFE_INTEGER : a.parsed.suffix;
      const bx = b.parsed.suffix === 0 ? Number.MAX_SAFE_INTEGER : b.parsed.suffix;
      return ax - bx;
    });

  let yielded = 0;
  const limit = opts.limit;
  const since = opts.since;

  for (const entry of files) {
    if (limit !== undefined && yielded >= limit) return;
    const stream = createReadStream(join(dir, entry.name), { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      let record: DecisionRecord;
      try {
        record = JSON.parse(line) as DecisionRecord;
      } catch {
        continue;
      }
      if (since !== undefined && record.timestamp < since) continue;
      yield record;
      yielded += 1;
      if (limit !== undefined && yielded >= limit) {
        rl.close();
        stream.destroy();
        return;
      }
    }
  }
}
