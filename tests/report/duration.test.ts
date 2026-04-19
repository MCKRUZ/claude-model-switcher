// Duration parser: `7d`, `24h`, `30m`, `60s`, `500ms`.
import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/report/duration.js';

describe('parseDuration', () => {
  it('parses 7d as 7 * 86_400_000 ms', () => {
    const r = parseDuration('7d');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(7 * 86_400_000);
  });

  it('parses 24h, 30m, 60s, 500ms', () => {
    const h = parseDuration('24h');
    const m = parseDuration('30m');
    const s = parseDuration('60s');
    const ms = parseDuration('500ms');
    expect(h.ok && h.value).toBe(24 * 3_600_000);
    expect(m.ok && m.value).toBe(30 * 60_000);
    expect(s.ok && s.value).toBe(60 * 1_000);
    expect(ms.ok && ms.value).toBe(500);
  });

  it('tolerates whitespace', () => {
    const r = parseDuration('  7d  ');
    expect(r.ok && r.value).toBe(7 * 86_400_000);
  });

  it('returns fail for invalid input', () => {
    for (const bad of ['', 'abc', '7', '7x', '-1d', '1.5d', 'd7', '7 d']) {
      const r = parseDuration(bad);
      expect(r.ok).toBe(false);
    }
  });
});
