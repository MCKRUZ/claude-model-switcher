// Zero-latency, deterministic local complexity scorer (§11).
// Synchronous under the hood; `async` only to satisfy Classifier.

import type {
  Classifier,
  ClassifierInput,
  ClassifierResult,
  Tier,
} from './types.js';

const IMPERATIVE_VERBS = /^(?:write|build|refactor|implement|design|debug|fix)\b/i;

const WEIGHTS = {
  toolBreadthFactor: 0.5,
  toolBreadthCap: 3,
  codeBlockFactor: 0.3,
  codeBlockCap: 2,
  filePathFactor: 0.4,
  filePathCap: 2,
} as const;

const BAND_LOW = 3.0;
const BAND_HIGH = 6.5;
const MAX_BOUNDARY_DIST = 3.5;
const CONF_FLOOR = 0.2;
const CONF_CEIL = 0.85;
const TEXT_SCAN_LIMIT = 64 * 1024;
const MAX_USEFUL_TRIPLES = Math.ceil((WEIGHTS.codeBlockCap / WEIGHTS.codeBlockFactor) * 2) + 2;

function tokenBand(n: number): number {
  if (n < 500) return 0;
  if (n < 2000) return 1;
  if (n < 8000) return 2;
  return 3;
}

function bandFromScore(score: number): Tier {
  if (score < BAND_LOW) return 'haiku';
  if (score < BAND_HIGH) return 'sonnet';
  return 'opus';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function flattenTextLoose(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function countCodeFences(body: unknown): number {
  if (!body || typeof body !== 'object') return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  let triples = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const text = flattenTextLoose((msg as { content?: unknown }).content);
    const scanned = text.length > TEXT_SCAN_LIMIT ? text.slice(0, TEXT_SCAN_LIMIT) : text;
    const matches = scanned.match(/```/g);
    if (matches) triples += matches.length;
    if (triples >= MAX_USEFUL_TRIPLES) break;
  }
  return Math.floor(triples / 2);
}

function lastUserText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== 'user') continue;
    return flattenTextLoose(m.content);
  }
  return '';
}

function phrasingDelta(lastText: string): number {
  if (IMPERATIVE_VERBS.test(lastText.trimStart())) return 1;
  if (lastText.includes('?')) return -1;
  return 0;
}

type ValidSignals = { readonly estInputTokens: number; readonly tools: readonly string[]; readonly fileRefCount: number };

function validateSignals(raw: unknown): ValidSignals | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const t = s.estInputTokens, f = s.fileRefCount;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
  if (typeof f !== 'number' || !Number.isFinite(f) || f < 0) return null;
  if (!Array.isArray(s.tools)) return null;
  return { estInputTokens: t, tools: s.tools as readonly string[], fileRefCount: f };
}

export class HeuristicClassifier implements Classifier {
  async classify(
    input: ClassifierInput,
    _deadline: AbortSignal,
  ): Promise<ClassifierResult | null> {
    const start = performance.now();
    try {
      const signals = validateSignals(input?.signals);
      if (!signals) return null;

      const tokenContribution = tokenBand(signals.estInputTokens);
      const toolContribution = Math.min(
        signals.tools.length * WEIGHTS.toolBreadthFactor,
        WEIGHTS.toolBreadthCap,
      );
      const codeContribution = Math.min(
        countCodeFences(input.body) * WEIGHTS.codeBlockFactor,
        WEIGHTS.codeBlockCap,
      );
      const phrasingContribution = phrasingDelta(lastUserText(input.body));
      const fileContribution = Math.min(
        signals.fileRefCount * WEIGHTS.filePathFactor,
        WEIGHTS.filePathCap,
      );

      const rawScore =
        tokenContribution + toolContribution + codeContribution +
        phrasingContribution + fileContribution;
      const score = clamp(rawScore, 0, 10);
      const suggestedModel = bandFromScore(score);
      const dist = Math.min(Math.abs(score - BAND_LOW), Math.abs(score - BAND_HIGH));
      const confidence = clamp(dist / MAX_BOUNDARY_DIST, CONF_FLOOR, CONF_CEIL);

      return {
        score, suggestedModel, confidence,
        source: 'heuristic',
        latencyMs: performance.now() - start,
      };
    } catch {
      return null;
    }
  }
}
