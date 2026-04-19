// Parse duration strings like `7d`, `24h`, `30m`, `60s`, `500ms` into
// milliseconds. Used by `ccmux report --since` and downstream tooling.

import { fail, ok, type Result } from '../types/result.js';

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const RE = /^(\d+)(ms|s|m|h|d)$/;

export function parseDuration(input: string): Result<number, string> {
  const trimmed = input.trim();
  const m = RE.exec(trimmed);
  if (m === null) return fail(`invalid duration: ${input}`);
  const [, digits, unit] = m;
  if (digits === undefined || unit === undefined) return fail(`invalid duration: ${input}`);
  const factor = UNIT_MS[unit];
  if (factor === undefined) return fail(`invalid duration unit: ${unit}`);
  return ok(Number(digits) * factor);
}
