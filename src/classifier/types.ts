// Shared classifier contract consumed by the heuristic scorer (§11),
// the Haiku classifier and race orchestrator (§12), and the decision
// log writer (§13). Fields are load-bearing — do not rename without
// coordinating with those sections.

import type { Signals } from '../signals/types.js';

export type Tier = 'haiku' | 'sonnet' | 'opus';

export interface ClassifierInput {
  readonly signals: Signals;
  /** Canonical body of the intercepted request (model excluded). */
  readonly body: unknown;
  /** Canonical hash from §7.2, used for cache keying by §12. */
  readonly requestHash: string;
}

export interface ClassifierResult {
  /** 0-10 complexity score. */
  readonly score: number;
  readonly suggestedModel: Tier;
  /** 0-1 self-reported confidence. */
  readonly confidence: number;
  readonly source: 'haiku' | 'heuristic';
  readonly latencyMs: number;
  readonly rationale?: string;
}

export interface Classifier {
  /**
   * Produces a result or `null`. MUST NOT throw on bad input — a
   * thrown classifier is treated as null by the orchestrator. The
   * deadline signal is accepted for interface parity with the Haiku
   * classifier; the heuristic ignores it (it's synchronous).
   */
  classify(
    input: ClassifierInput,
    deadline: AbortSignal,
  ): Promise<ClassifierResult | null>;
}
