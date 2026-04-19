import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderDiff } from '../../src/tune/diff.js';
import type { Suggestion } from '../../src/tune/suggest.js';

const FIXTURE = join(__dirname, 'fixtures', 'config.yaml');

describe('renderDiff', () => {
  it('produces a valid unified diff header', () => {
    const yaml = readFileSync(FIXTURE, 'utf8');
    const sugg: readonly Suggestion[] = [
      { ruleId: 'trivial-to-haiku', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'fires=100 frustration=70%' },
    ];
    const diff = renderDiff(FIXTURE, yaml, sugg);
    expect(diff).toMatch(/^--- /m);
    expect(diff).toMatch(/^\+\+\+ /m);
    expect(diff).toMatch(/^@@ /m);
    expect(diff).toMatch(/-.*choice: haiku/);
    expect(diff).toMatch(/\+.*choice: sonnet/);
  });

  it('returns empty string when suggestions are empty', () => {
    const yaml = readFileSync(FIXTURE, 'utf8');
    expect(renderDiff(FIXTURE, yaml, [])).toBe('');
  });

  it('returns empty string when rule id is not found', () => {
    const yaml = readFileSync(FIXTURE, 'utf8');
    const sugg: readonly Suggestion[] = [
      { ruleId: 'nonexistent', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'x' },
    ];
    expect(renderDiff(FIXTURE, yaml, sugg)).toBe('');
  });

  it('produces separate hunks for multiple suggestions', () => {
    const yaml = readFileSync(FIXTURE, 'utf8');
    const sugg: readonly Suggestion[] = [
      { ruleId: 'plan-to-opus', kind: 'escalate-target', currentTier: 'opus', proposedTier: 'opus', rationale: 'x' },
      { ruleId: 'trivial-to-haiku', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'x' },
    ];
    const diff = renderDiff(FIXTURE, yaml, sugg);
    const hunkCount = (diff.match(/^@@ /gm) ?? []).length;
    // plan-to-opus → opus is a no-op replacement (same tier), so only 1 hunk
    expect(hunkCount).toBe(1);
  });

  it('handles quoted YAML values', () => {
    const yaml = 'rules:\n  - id: "my-rule"\n    then: { choice: "haiku" }\n';
    const sugg: readonly Suggestion[] = [
      { ruleId: 'my-rule', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'x' },
    ];
    const diff = renderDiff('config.yaml', yaml, sugg);
    expect(diff).toMatch(/\+.*choice: sonnet/);
  });

  it('skips rule blocks that use escalate: (not choice:)', () => {
    const yaml = readFileSync(FIXTURE, 'utf8');
    const sugg: readonly Suggestion[] = [
      { ruleId: 'retry-escalate', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'x' },
    ];
    expect(renderDiff(FIXTURE, yaml, sugg)).toBe('');
  });
});
