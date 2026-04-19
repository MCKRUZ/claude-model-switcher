# section-12-classifier-haiku

Haiku-backed classifier that asks `claude-haiku-4-5` to score complexity for requests that neither a policy rule nor sticky-model routing have resolved. It races the deterministic heuristic classifier (section-11) and is wrapped by `RaceClassifier` in `classifier/index.ts`.

## Dependencies

- **section-03-config** — supplies `classifier.model`, `classifier.timeoutMs`, `classifier.thresholds.haiku`, and the outbound host (fixed to `https://api.anthropic.com/v1/messages`).
- **section-09-sticky-model** — supplies `Tier` union and `ClassifierInput` shape (request body, session hash, extracted signals).

Parallelizable with section-10-wrapper, section-11-classifier-heuristic, section-13-decision-log. Blocks section-15-report-cli.

## Files to Create

- `src/classifier/types.ts` — `Classifier` interface and `ClassifierResult` type (shared with heuristic; create here if section-11 hasn't already — coordinate via a single exported file).
- `src/classifier/haiku.ts` — the Haiku classifier implementation.
- `src/classifier/prompt.ts` — the static classifier prompt (stable prefix + `cache_control` marker) exported as a constant so the outbound body is identical across calls.
- `tests/classifier/haiku.test.ts` — tests below.
- `tests/classifier/fixtures/` — minimal ClassifierInput fixtures (one small, one large, one multi-tool).

## Interface Contract

```ts
// src/classifier/types.ts
export interface ClassifierResult {
  score: number;                 // 0..10
  suggestedModel: 'opus' | 'sonnet' | 'haiku';
  confidence: number;            // 0..1
  rationale?: string;
  source: 'haiku' | 'heuristic';
  latencyMs: number;
  classifierCostUsd?: number;    // present only for 'haiku' source
}

export interface Classifier {
  classify(input: ClassifierInput, deadline: AbortSignal): Promise<ClassifierResult | null>;
}
```

A classifier that throws is treated as returning `null`; it MUST NEVER fail the user's upstream request.

## Implementation Requirements

### Outbound host allowlist (load-bearing)

The Haiku classifier constructs its URL from a module-level constant:

```ts
const HAIKU_ENDPOINT = 'https://api.anthropic.com/v1/messages';
```

The factory `createHaikuClassifier(deps)` MUST assert at startup (not on first call) that any configured override resolves to exactly this URL. Any other origin throws synchronously during construction. There is no config knob to relax this. Include an exported `assertAllowedEndpoint(url: string): void` helper so tests and `init` can share the check.

### Header forwarding

On each `classify()` call, read `input.incomingHeaders` (the intercepted request's headers, sanitized by section-04 so auth is preserved) and forward **exactly**:

- `authorization` OR `x-api-key` — whichever was present on the intercepted request. Never both. Never substituted.
- `anthropic-version` — forward verbatim; if absent, do not synthesize.
- `anthropic-beta` — forward verbatim (may be a comma-joined list; preserve as-is).
- `content-type: application/json` — always set.

No other auth mechanism is permitted. No `ANTHROPIC_API_KEY` env-fallback. If neither `authorization` nor `x-api-key` is present on the incoming request, the classifier resolves to `null` without making a network call.

### Prompt + cache_control

The body is a small fixed prompt instructing Haiku to emit strict JSON. The prompt lives in `src/classifier/prompt.ts` and includes a stable prefix marked with `cache_control: { type: 'ephemeral' }` on the system block so Haiku's own call benefits from prompt caching. The only variable portion is the (summarized) user request appended as the last user message. Keep the prompt under ~500 tokens so cache hits dominate cost.

Expected model response: a JSON object `{complexity: 0-10, suggestedModel: "opus"|"sonnet"|"haiku", confidence: 0-1, rationale?: string}`. Parse strictly; reject on schema mismatch and return `null`.

### Timeout

Default 800ms (override from `config.classifier.timeoutMs`). Use a single `AbortController`:

- The incoming `deadline` parameter is the race-level deadline from `RaceClassifier`.
- Layer a local 800ms timer on top, `AbortSignal.any([deadline, localTimer])`.
- On abort, the pending `undici.fetch` is cancelled and the classifier resolves to `null`. **Cancelling the classifier MUST NOT cancel or affect the upstream user request** — they are independent dispatches.

### Cost reporting

Parse `usage` from the Haiku response (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and compute `classifierCostUsd` using the pricing table from config. This field is tagged **separately** from the user request's `cost_estimate_usd` so section-15's "with / without classifier overhead" totals can subtract it cleanly.

### Non-goals

- No retry logic. One shot, timeout or success.
- No fallback model. If configured `classifier.model` is unavailable, the call fails and returns `null`.
- No caching here — the shared result cache lives in `classifier/index.ts` (§8.4) and is keyed on the canonical request hash (which excludes `model`).

## Tests (tests/classifier/haiku.test.ts)

Write these first. Use `msw` or `undici`'s `MockAgent` to intercept outbound fetches.

```ts
describe('haiku classifier', () => {
  it('throws at construction when configured endpoint is not api.anthropic.com/v1/messages', () => { /* ... */ });

  it('forwards x-api-key, anthropic-version, anthropic-beta from the intercepted request', async () => { /* assert on captured outbound headers */ });

  it('forwards authorization when x-api-key is absent', async () => { /* ... */ });

  it('resolves to null when neither x-api-key nor authorization is present (no network call)', async () => { /* assert MockAgent received zero calls */ });

  it('hard-timeout at 800ms resolves to null and aborts its own fetch only', async () => {
    // Mock upstream to hang; assert classifier promise resolves to null at ~800ms.
    // Assert a separate "upstream" mock is NOT aborted by this.
  });

  it('outbound body contains cache_control marker on the system prompt prefix', async () => {
    // Capture body, JSON.parse, assert system[0].cache_control.type === 'ephemeral'.
  });

  it('parses valid JSON response into ClassifierResult with source: "haiku"', async () => { /* ... */ });

  it('returns null on malformed JSON in model response', async () => { /* ... */ });

  it('computes classifierCostUsd from usage fields (including cache tokens) using pricing table', async () => { /* ... */ });

  it('does not throw on upstream 5xx — returns null', async () => { /* ... */ });
});
```

Also add one allowlist unit test:

```ts
describe('assertAllowedEndpoint', () => {
  it('accepts https://api.anthropic.com/v1/messages', () => { /* no throw */ });
  it('throws on any other host, path, or scheme', () => { /* parametrize */ });
});
```

## Acceptance Criteria

1. All tests above pass under `vitest run tests/classifier/haiku.test.ts`.
2. A grep of the built `dist/classifier/haiku.js` shows the literal string `https://api.anthropic.com/v1/messages` and no other `api.*` or HTTP URL.
3. Cancelling a classifier call (via timeout) leaves any concurrent `/v1/messages` proxy call in section-04 unaffected — covered by an integration test when section-15 lands, but verify manually here by running two concurrent requests with the classifier forced to time out.
4. `classifierCostUsd` appears in `ClassifierResult` only when `source === 'haiku'` and the response parsed cleanly.

## Implementation Notes (post-build)

- **Files actually created/modified:**
  - `src/classifier/types.ts` — extended (added optional `incomingHeaders` to `ClassifierInput` and optional `classifierCostUsd` to `ClassifierResult`; both opt-in to avoid breaking the §11 heuristic).
  - `src/classifier/prompt.ts` — new; exports `CLASSIFIER_PROMPT` and `CLASSIFIER_PROMPT_VERSION`.
  - `src/classifier/haiku.ts` — new; exports `HAIKU_ENDPOINT`, `assertAllowedEndpoint`, `createHaikuClassifier`, `HaikuClassifierDeps`.
  - `tests/classifier/haiku.test.ts` — new (30 tests).
  - `tests/classifier/fixtures/haiku/{small,large,multi-tool}.json` — new minimal `ClassifierInput` fixtures.

- **Cost formula:** uses explicit `PricingEntry` fields (`input`, `output`, `cacheRead`, `cacheCreate`) directly — not multipliers off `input`. PricingEntry was already richer than the spec assumed.

- **Mocking choice:** the section spec suggested `msw` or undici's `MockAgent`. We use a lighter approach — the factory accepts an injected `fetchImpl`, and tests pass a `vi.fn` that records calls. Avoids the dev-dependency churn of adding `msw` and keeps the test surface narrower (raw URL/headers/body assertions).

- **Code-review fixes applied (see `planning/implementation/code_review/section-12-interview.md`):**
  - Short-circuit when `deadline.aborted` at entry, eliminating a timer leak if `AbortSignal.any` were called against an already-aborted signal.
  - `clearTimeout` moved to outermost `finally` so the timeout budget covers `response.json()` body read, not just the headers fetch.
  - Added test: both `x-api-key` and `authorization` present → only `x-api-key` is forwarded.
  - Added test: 4xx response returns `null` and never invokes `response.json()` (no auth-key leakage path).
  - The `deps.endpoint` factory parameter retained as a defensive allowlist hook for future config plumbing (per user decision); clarifying comment added.

- **Out of scope:** `RaceClassifier` orchestration in `src/classifier/index.ts` is owned by §11/§13 — left as the existing placeholder. The shared result cache referenced in §8.4 is also not introduced here.

- **Test status:** 30/30 pass. Pre-existing typecheck error in `tests/policy/recipes.test.ts` (import-assertion syntax) is unrelated and not introduced by this section.
