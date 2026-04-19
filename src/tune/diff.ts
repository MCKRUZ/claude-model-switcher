// Hand-rolled unified-diff renderer for tune proposals. We never write to the
// config file — this builds a standard unified-diff string on top of the YAML
// we read from disk. Only targets rules whose `then:` uses `choice: <tier>`;
// `escalate: N` rules are skipped because the proposal is tier-expressed.

import type { Suggestion } from './suggest.js';

export function renderDiff(
  path: string,
  yaml: string,
  suggestions: readonly Suggestion[],
): string {
  if (suggestions.length === 0) return '';
  const lines = yaml.split('\n');
  const hunks: string[] = [];
  for (const sugg of suggestions) {
    const hunk = hunkFor(lines, sugg);
    if (hunk !== null) hunks.push(hunk);
  }
  if (hunks.length === 0) return '';
  const header = `--- ${path}\n+++ ${path}\n`;
  return header + hunks.join('');
}

function hunkFor(lines: readonly string[], sugg: Suggestion): string | null {
  const idLine = findRuleIdLine(lines, sugg.ruleId);
  if (idLine === -1) return null;
  const choiceLine = findChoiceLine(lines, idLine);
  if (choiceLine === -1) return null;
  const original = lines[choiceLine];
  if (original === undefined) return null;
  const replaced = original.replace(
    /choice:\s*["']?(haiku|sonnet|opus)["']?/,
    `choice: ${sugg.proposedTier}`,
  );
  if (replaced === original) return null;
  const contextBefore = Math.max(0, choiceLine - 2);
  const contextAfter = Math.min(lines.length - 1, choiceLine + 2);
  const parts: string[] = [];
  const originalRange = contextAfter - contextBefore + 1;
  parts.push(`@@ -${contextBefore + 1},${originalRange} +${contextBefore + 1},${originalRange} @@\n`);
  for (let i = contextBefore; i < choiceLine; i += 1) {
    parts.push(` ${lines[i] ?? ''}\n`);
  }
  parts.push(`-${original}\n`);
  parts.push(`+${replaced}\n`);
  for (let i = choiceLine + 1; i <= contextAfter; i += 1) {
    parts.push(` ${lines[i] ?? ''}\n`);
  }
  return parts.join('');
}

function findRuleIdLine(lines: readonly string[], ruleId: string): number {
  const re = new RegExp(`^\\s*-?\\s*id:\\s*["']?${escapeRe(ruleId)}["']?\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i] ?? '')) return i;
  }
  return -1;
}

function findChoiceLine(lines: readonly string[], startLine: number): number {
  // Search forward until the next rule-id line (indent-insensitive sentinel)
  // or end of file. We stop early if we see another `- id:` entry.
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*-\s*id:/.test(line) && i !== startLine) return -1;
    if (/choice:\s*["']?(haiku|sonnet|opus)["']?/.test(line)) return i;
  }
  return -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
