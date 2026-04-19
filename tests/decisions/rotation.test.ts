import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRetention,
  dailyFilename,
  nextSizeFilename,
  parseLogFilename,
  rotateRename,
} from '../../src/decisions/rotate.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ccmux-rot-'));
}

describe('rotation', () => {
  it('parses daily and size-suffixed filenames; ignores unrelated files', () => {
    expect(parseLogFilename('decisions-2026-04-17.jsonl')).toEqual({ date: '2026-04-17', suffix: 0 });
    expect(parseLogFilename('decisions-2026-04-17.3.jsonl')).toEqual({ date: '2026-04-17', suffix: 3 });
    expect(parseLogFilename('outcomes.jsonl')).toBeNull();
    expect(parseLogFilename('random.txt')).toBeNull();
  });

  it('daily strategy uses a date-stamped filename', () => {
    const d = new Date('2026-04-17T12:34:56Z');
    // Daily filename uses local-time components; assert against a parse of the result.
    const parsed = parseLogFilename(dailyFilename(d));
    expect(parsed?.suffix).toBe(0);
    expect(parsed?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('nextSizeFilename increments the suffix beyond the existing max', () => {
    const dir = tmpDir();
    const date = new Date(2026, 3, 17, 12, 0, 0); // local
    writeFileSync(join(dir, dailyFilename(date)), '');
    writeFileSync(join(dir, 'decisions-2026-04-17.1.jsonl'), '');
    writeFileSync(join(dir, 'decisions-2026-04-17.5.jsonl'), '');
    const next = nextSizeFilename(dir, date);
    expect(next).toBe('decisions-2026-04-17.6.jsonl');
  });

  it('rotateRename falls back to copy+truncate when rename throws EBUSY', async () => {
    const dir = tmpDir();
    const src = join(dir, 'decisions-2026-04-17.jsonl');
    const dst = join(dir, 'decisions-2026-04-17.1.jsonl');
    writeFileSync(src, 'hello\n');
    const err = Object.assign(new Error('busy'), { code: 'EBUSY' }) as NodeJS.ErrnoException;
    const { fsHelpers } = await import('../../src/decisions/_fs.js');
    const spy = vi.spyOn(fsHelpers, 'renameSync').mockImplementationOnce(() => { throw err; });
    try {
      rotateRename(src, dst);
    } finally {
      spy.mockRestore();
    }
    const entries = readdirSync(dir).sort();
    expect(entries).toContain('decisions-2026-04-17.1.jsonl');
    expect(entries).toContain('decisions-2026-04-17.jsonl');
  });

  it('rotateRename rethrows non-recoverable errors', async () => {
    const dir = tmpDir();
    const src = join(dir, 'a.jsonl');
    writeFileSync(src, '');
    const err = Object.assign(new Error('disk gone'), { code: 'EIO' }) as NodeJS.ErrnoException;
    const { fsHelpers } = await import('../../src/decisions/_fs.js');
    const spy = vi.spyOn(fsHelpers, 'renameSync').mockImplementationOnce(() => { throw err; });
    try {
      expect(() => rotateRename(src, join(dir, 'b.jsonl'))).toThrow(/disk gone/);
    } finally {
      spy.mockRestore();
    }
  });

  it('retention parses dates from the filename, not mtime', () => {
    const dir = tmpDir();
    // Old-by-name files should be deleted.
    writeFileSync(join(dir, 'decisions-2024-01-01.jsonl'), '');
    writeFileSync(join(dir, 'decisions-2024-01-02.3.jsonl'), '');
    // Recent-by-name should survive even if mtime is fresh.
    writeFileSync(join(dir, 'decisions-2026-04-17.jsonl'), '');
    // Unrelated files left alone.
    writeFileSync(join(dir, 'outcomes.jsonl'), '');
    const removed = applyRetention(dir, 30, new Date('2026-04-17T00:00:00Z'));
    expect([...removed].sort()).toEqual([
      'decisions-2024-01-01.jsonl',
      'decisions-2024-01-02.3.jsonl',
    ]);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['decisions-2026-04-17.jsonl', 'outcomes.jsonl']);
  });

  it('retention with retentionDays <= 0 is a no-op', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'decisions-2024-01-01.jsonl'), '');
    expect(applyRetention(dir, 0, new Date()).length).toBe(0);
    expect(readdirSync(dir).length).toBe(1);
  });

});
