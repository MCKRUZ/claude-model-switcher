import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { DecisionRecord } from '../decisions/types.js';

const LOG_FILE_RE = /^decisions-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;

export interface ReadOpts {
  readonly since?: Date;
  readonly limit: number;
  readonly offset?: number;
}

export interface ReadResult {
  readonly items: readonly DecisionRecord[];
  readonly totalScanned: number;
}

function findLogFiles(logDir: string): string[] {
  try {
    return readdirSync(logDir)
      .filter(f => LOG_FILE_RE.test(f))
      .sort()
      .map(f => join(logDir, f));
  } catch {
    return [];
  }
}

async function streamRecords(
  filePath: string,
  sinceMs: number,
  out: DecisionRecord[],
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as DecisionRecord;
      if (sinceMs > 0 && new Date(record.timestamp).getTime() < sinceMs) continue;
      out.push(record);
    } catch {
      // skip malformed lines
    }
  }
}

export async function readDecisions(
  logDir: string,
  opts: ReadOpts,
): Promise<ReadResult> {
  const files = findLogFiles(logDir);
  const records: DecisionRecord[] = [];
  const sinceMs = opts.since ? opts.since.getTime() : 0;

  for (const file of files) {
    await streamRecords(file, sinceMs, records);
  }

  records.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const totalScanned = records.length;
  const offset = opts.offset ?? 0;
  const items = records.slice(offset, offset + opts.limit);

  return { items, totalScanned };
}
