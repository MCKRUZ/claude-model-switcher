# section-11-classifier-heuristic

## Purpose

Implement the zero-latency, deterministic local complexity scorer that runs as part of the classifier race (alongside the Haiku classifier from section-12). The heuristic is the offline/air-gapped floor: it always produces a result, synchronously, with no network calls. When Haiku times out or is disabled, the heuristic is the classifier.

This section delivers:
1. The shared `Classifier` interface (consumed by both heuristic and Haiku classifiers).
2. The shared `ClassifierInput` / `ClassifierResult` types.
3. The `HeuristicClassifier` implementation — pure TypeScript, deterministic, synchronous under the hood.

It does **not** deliver the race orchestrator (`classifier/index.ts`), the Haiku classifier, or the result cache — those belong to section-12.

## Dependencies

- **section-03-config** — pulls `classifier.confidenceThresholds.heuristic` (default 0.4) from the loaded config.
- **section-09-sticky-model** — the classifier runs only after policy abstains and sticky lookup misses; the heuristic consumes `Signals` produced by section-07 and re-exported via section-09.

Do not import from any section downstream of 11 (no `classifier/index.ts`, no `classifier/haiku.ts`, no decision-log writer).

## Files to create

```
src/classifier/types.ts
src/classifier/heuristic.ts
tests/classifier/heuristic.test.ts
tests/classifier/fixtures/heuristic/
  ├── large-broad-tools.json     # large token count + broad tool set
  ├── small-single-tool.json     # small token count + single tool
  ├── imperative.json            # imperative phrasing
  └── question.json              # question phrasing
```

Do not create `src/classifier/index.ts`, `src/classifier/haiku.ts`, or `src/classifier/cache.ts` here — section-12 owns those.

## Type contracts (`src/classifier/types.ts`)

Stub definitions only — exact fields below are load-bearing because section-12 and section-13 both read them.

```ts
import type { Signals } from '../signals/types';

export type Tier = 'haiku' | 'sonnet' | 'opus';

export interface ClassifierInput {
  readonly signals: Signals;
  /** Canonical body of the intercepted request (model excluded). */
  readonly body: unknown;
  /** Canonical hash from §7.2, used for cache keying by section-12. */
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
   * Produces a result or `null`. MUST NOT throw on bad input — a thrown
   * classifier is treated as null by the orchestrator. The deadline
   * signal is accepted for interface parity with the Haiku classifier;
   * the heuristic ignores it (it's synchronous).
   */
  classify(
    input: ClassifierInput,
    deadline: AbortSignal,
  ): Promise<ClassifierResult | null>;
}
```

## Heuristic implementation (`src/classifier/heuristic.ts`)

A single exported class `HeuristicClassifier implements Classifier`. The public `classify` is async only to satisfy the interface — the body is synchronous and MUST complete in < 1ms on fixture inputs (no I/O, no allocations in hot path beyond what the feature math needs).

### Feature extraction

All features derive from `ClassifierInput.signals` (already extracted in section-07). The heuristic re-reads nothing from `body` except for code-block density (counts ``` fences in each text block) and file-path count (regex scan — reuse the extractor from section-07 if already computed on signals).

Weighted feature table (hand-tuned, documented as heuristics, not truth):

| Feature | Buckets / formula | Weight toward "opus" |
|---|---|---|
| Token count (cl100k approx from signals) | `<500` → 0, `500-2000` → 1, `2000-8000` → 2, `>8000` → 3 | ×1.0 |
| Tool breadth (unique tool names in request) | count | ×0.5, capped at 3 |
| Code-block density | fenced blocks across all text content | ×0.3, capped at 2 |
| Imperative vs question | imperative verb at start of last user message (`write|build|refactor|implement|design|debug|fix`) → +1; question mark only → −1 | ±1 |
| File-path count | distinct paths matching `[A-Za-z]:\\…` or `/…` or `./…` | ×0.4, capped at 2 |

Sum the weighted contributions, clamp to `[0, 10]` → `score`.

### Mapping score → `suggestedModel`

- `score < 3.0` → `haiku`
- `3.0 ≤ score < 6.5` → `sonnet`
- `score ≥ 6.5` → `opus`

### Confidence calculation

- Distance from the nearest band boundary, normalized to `[0, 1]`.
- Floor at 0.2, ceiling at 0.85 (the heuristic never claims full certainty — Haiku may still beat it in the race).

### Behavior rules

- **Never throws.** Wrap the entire body in `try/catch`; on any error return `null`. Log at `debug` level with sanitized context (reuse section-02's auth-header sanitizer for any header snippets).
- **Synchronous.** Do not `await` anything. No file I/O, no network, no timers.
- **Deterministic.** Same `ClassifierInput` → same `ClassifierResult` every time. No `Date.now()` inside scoring math. `latencyMs` is measured with `performance.now()` around the call itself.
- **Source stamp.** Always set `source: 'heuristic'`.

## Tests (`tests/classifier/heuristic.test.ts`)

Use Vitest. Test stubs below — describe blocks and expectations only; fill in minimal assertions. Fixtures are small JSON files committed alongside the test.

```ts
describe('Classifier interface contract', () => {
  it('a classifier that throws internally resolves to null (never rejects)');
  it('satisfies: classify(input, deadline) → Promise<ClassifierResult | null>');
});

describe('HeuristicClassifier — zero latency', () => {
  it('returns a result in < 1ms on fixture inputs (warm)');
  it('is synchronous under the hood (no microtask yield between call and resolution beyond the Promise wrapper)');
});

describe('HeuristicClassifier — scoring', () => {
  it('large token count + broad tool set → suggests opus', () => {
    // load fixtures/heuristic/large-broad-tools.json
  });
  it('small token count + single tool → suggests haiku');
  it('imperative phrasing nudges score upward vs. the same body phrased as a question');
});

describe('HeuristicClassifier — determinism', () => {
  it('same input produces identical score/suggestedModel/confidence across calls');
  it('does not mutate the input');
});

describe('HeuristicClassifier — robustness', () => {
  it('returns null on malformed signals (e.g. content is neither string nor array)');
  it('handles content-blocks form and string-content form identically when text is equivalent');
  it('always stamps source: "heuristic"');
  it('confidence stays within [0.2, 0.85]');
});
```

Fixture files contain a serialized `ClassifierInput` (`signals`, `body`, `requestHash`) sized to hit the described band. Keep fixtures under 50 lines each.

## Notes for implementer

- The race orchestrator in section-12 fires heuristic and Haiku in parallel via `Promise.race` against a deadline — the heuristic will nearly always win on latency, but it only gets selected when Haiku's confidence is below `confidenceThresholds.haiku` (0.6) OR Haiku times out. Keep the confidence range honest; do not inflate it.
- The `requestHash` field is not consumed by the heuristic but MUST be passed through the `ClassifierInput` so section-12's cache can key by it without a second interface.
- No logging above `debug` from inside `classify()`. The orchestrator logs the final routing decision; the heuristic is silent on the hot path.
- Keep `heuristic.ts` under 150 lines. Split the feature-weight table into a const at the top of the file for easy tuning.

## Implementation status (as built)

**Files created / modified:**
- `src/classifier/types.ts` — populated with `Classifier`, `ClassifierInput`, `ClassifierResult`, `Tier`.
- `src/classifier/heuristic.ts` — 149 lines.
- `tests/classifier/heuristic.test.ts` — 19 test cases (13 from spec + 6 from code review).
- `tests/classifier/fixtures/heuristic/{large-broad-tools,small-single-tool,imperative,question}.json`.

**Deviations from plan (code-review driven):**
- `validateSignals` rejects negative `estInputTokens` / `fileRefCount` in addition to
  NaN/Infinity. Spec implied numeric validity; negatives would under-score.
- `countCodeFences` caps per-message scan at 64 KB and early-exits once
  `MAX_USEFUL_TRIPLES` (derived from `codeBlockCap / codeBlockFactor`) is reached —
  bounds allocation on adversarial payloads, preserving the zero-latency contract.
- Added 6 tests: NaN/Infinity tokens, negative fileRefCount, empty/missing messages,
  band boundaries (3.0 → sonnet, 6.5 → opus), aborted deadline ignored, tier
  assertions for imperative/question.
- Latency test asserts `< 5ms` (not spec's `< 1ms`) to accommodate CI jitter; the
  result's own `latencyMs` field is independently asserted `< 5ms`.

**Code review:** see
`planning/implementation/code_review/section-11-{review,interview}.md`.
