# section-09-sticky-model

## Purpose

Implement the sticky-model subsystem: an in-memory per-session store that remembers which model tier a session has been routed to, plus a policy layer that enforces asymmetric escalation (cheap→expensive is free; expensive→cheap requires explicit rule consent). This runs after the rule-based policy (section-08) and before the classifier (sections 11/12), and is the single arbiter that turns a rule outcome (`{choice}`, `{escalate:N}`, or abstain) plus prior session state into a final `chosen_model`.

## Dependencies

- **section-08-policy** (consumed): provides the `PolicyResult` union (`{choice}`, `{escalate:N}`, `{abstain:true}`) and rule metadata (`allowDowngrade`).
- **section-03-config** (consumed): provides `config.modelTiers` (custom model→tier map), `config.stickyModel.enabled`, `config.stickyModel.sessionTtlMs`, and the HMAC salt used for `sessionId` derivation.
- **section-07-signals** (consumed): supplies `signals.explicitModel` and `signals.sessionId` (128-bit hex, already HMAC-salted per §7.2 — do not re-hash here).

## Files to Create

```
src/sticky/
  store.ts       # in-memory Map + TTL eviction
  policy.ts      # tier-aware decision resolution
  tiers.ts       # tier ordering + modelId→tier mapping
  types.ts       # StickyEntry, StickyDecision, Tier
tests/sticky/
  store.test.ts
  policy.test.ts
  tiers.test.ts
```

## Background (self-contained)

### Tier ordering

Three built-in tiers with total ordering:

```
haiku (0) < sonnet (1) < opus (2)
```

Any concrete `modelId` (e.g. `claude-haiku-4-5-20251001`, `claude-sonnet-4-5`, `claude-opus-4-7`) MUST resolve to exactly one tier. Known Anthropic model families map by substring match on the family name (`haiku`, `sonnet`, `opus`). Any model NOT matching a known family MUST be present in `config.modelTiers` at config-load time; otherwise config validation fails (this check lives in section-03, but `tiers.ts` exposes the resolution function the validator calls).

### Sticky entry shape

```ts
export interface StickyEntry {
  readonly sessionId: string;        // from signals, already HMAC-hex
  readonly tier: Tier;
  readonly modelId: string;          // concrete model last forwarded
  readonly createdAt: number;        // epoch ms
  readonly lastSeenAt: number;       // epoch ms, updated on every read/write
  readonly turnCount: number;        // incremented each time the session routes a request
}
```

### Asymmetric escalation rules

Executed in this order (short-circuit on first accept):

1. **Explicit model precedence.** If `signals.explicitModel` is set AND the policy abstained (no `{choice}` and no `{escalate}`), honor the explicit model verbatim. Update sticky. Return `chosen_by: "explicit"`. Skip classifier.
2. **Rule `{choice: X}`:**
   - If no sticky exists: accept X.
   - If `tier(X) > tier(sticky)`: accept X (escalation is always free).
   - If `tier(X) === tier(sticky)`: accept X, refresh `lastSeenAt`.
   - If `tier(X) < tier(sticky)`: accept only if the rule was tagged `allowDowngrade: true`; otherwise keep sticky and return `chosen_by: "sticky"` with a `downgradeBlocked` reason field on the decision.
3. **Rule `{escalate: N}`:** new tier = `min(opus, tier(sticky ?? defaultTier) + N)`. Pick a concrete `modelId` for that tier from `config.modelTiers` reverse-map (first entry for that tier, deterministic by insertion order). Update sticky.
4. **Rule abstained AND sticky exists AND within TTL:** return sticky. `chosen_by: "sticky"`.
5. **Rule abstained AND no sticky (or TTL-expired):** return `{abstain: true}` so the caller falls through to the classifier (Phase 2). The sticky layer does NOT pick a default model on its own — that is section-10's / the classifier fallback's job.
6. **Shadow mode (`config.mode === "shadow"`):** all logic above still runs and the decision is fully populated, but the caller forwards the client's original model. This is a policy flag passed through; the sticky layer does NOT branch on it — it just logs `chosen_by` unchanged and lets section-10 handle the forward. (Mentioned here so the implementer knows not to add shadow-specific branches in `sticky/policy.ts`.)

### TTL and eviction

- `sessionTtlMs` default 7_200_000 (2h) from config.
- Eviction is **lazy on access**: when `get(sessionId)` is called, if `now - lastSeenAt > ttl`, delete the entry and return `undefined`.
- Size cap: 10_000 entries. On `set()` when at cap, evict the entry with the oldest `lastSeenAt` (single linear scan is acceptable — cap is unlikely to be hit; no need for an LRU data structure).
- No background timers. No persistence. Process restart = empty store (documented behavior; sticky is a hint, not state of record).

### Session IDs are already hashed

`signals.sessionId` arrives as a 128-bit hex string produced by section-07 using HMAC-SHA256 over the upstream session cookie / header with the salt from config. The sticky store treats it as an opaque key. **Do not re-hash, do not log the raw value with PII — it is already safe, but it is still a stable identifier, so log at debug level only.**

## API Surface

```ts
// src/sticky/types.ts
export type Tier = "haiku" | "sonnet" | "opus";

export interface StickyEntry { /* as above */ }

export type StickyDecision =
  | { kind: "chosen"; modelId: string; tier: Tier; chosenBy: "explicit" | "policy" | "sticky" | "escalate" }
  | { kind: "abstain"; reason: "no-sticky" | "ttl-expired" | "downgrade-blocked"; sticky?: StickyEntry };

// src/sticky/tiers.ts
export function compareTiers(a: Tier, b: Tier): number;        // -1 / 0 / 1
export function tierOf(modelId: string, overrides: ReadonlyMap<string, Tier>): Tier;  // throws on unmapped unknown family
export function firstModelIdForTier(tier: Tier, tierMap: ReadonlyMap<string, Tier>): string | undefined;

// src/sticky/store.ts
export interface StickyStore {
  get(sessionId: string, now: number): StickyEntry | undefined;
  set(entry: StickyEntry): void;
  touch(sessionId: string, now: number): void;          // refresh lastSeenAt + increment turnCount
  size(): number;
}
export function createStickyStore(opts: { ttlMs: number; maxEntries?: number }): StickyStore;

// src/sticky/policy.ts
export interface ResolveInput {
  readonly sessionId: string;
  readonly policyResult: PolicyResult;                   // from section-08
  readonly explicitModel: string | null;
  readonly defaultTier: Tier;                             // from config, used only for escalate-with-no-sticky
  readonly tierMap: ReadonlyMap<string, Tier>;
  readonly now: number;
}
export function resolveStickyDecision(store: StickyStore, input: ResolveInput): StickyDecision;
```

Keep `resolveStickyDecision` pure aside from its one mutation point: it calls `store.set` / `store.touch` only on `kind: "chosen"` outcomes. Abstain outcomes never mutate the store.

## Tests (write first — RED)

Stub out each of the following in `tests/sticky/`. Use `vitest`. Mock time by passing `now` explicitly (no `Date.now()` inside production code — always take `now` as a parameter).

### `tiers.test.ts`

- `compareTiers` returns `-1 / 0 / 1` for all 9 ordered pairs of `haiku | sonnet | opus`.
- `tierOf("claude-haiku-4-5-20251001", emptyMap)` returns `"haiku"` via family-name substring.
- `tierOf("claude-sonnet-4-5", emptyMap)` returns `"sonnet"`.
- `tierOf("claude-opus-4-7", emptyMap)` returns `"opus"`.
- `tierOf("some-custom-fine-tune", emptyMap)` throws (unmapped unknown family). This is the "custom modelId without explicit tier mapping is rejected" guarantee.
- `tierOf("some-custom-fine-tune", new Map([["some-custom-fine-tune", "sonnet"]]))` returns `"sonnet"`.
- `firstModelIdForTier("haiku", ...)` returns the first modelId whose tier is haiku, by insertion order.

### `store.test.ts`

- `get` on an unknown sessionId returns `undefined`.
- `set` then `get` within TTL returns the same entry.
- `get` after `now` advances past `lastSeenAt + ttlMs` returns `undefined` AND removes the entry (next `size()` drops by 1).
- `touch` updates `lastSeenAt` to `now` and increments `turnCount` by 1.
- `touch` on unknown sessionId is a no-op (does not create an entry).
- Size cap: with `maxEntries: 2`, inserting a third entry evicts the one with the oldest `lastSeenAt`.
- Eviction is lazy only — no timer fires without a call to `get`.

### `policy.test.ts`

- **Tier order enforced.** With sticky=sonnet and rule `{choice: "claude-haiku-4-5-20251001"}` without `allowDowngrade`, decision is `abstain` with reason `"downgrade-blocked"` and sticky is preserved.
- **Downgrade with `allowDowngrade: true`** on the rule produces `kind: chosen`, `tier: haiku`, `chosenBy: "policy"`, and updates sticky to haiku.
- **Escalation is free.** Sticky=haiku, rule `{choice: opus-model}` → accept, `chosenBy: "policy"`.
- **Equal tier.** Sticky=sonnet, rule `{choice: <another sonnet>}` → accept, sticky updated to the new modelId, `lastSeenAt` refreshed.
- **Explicit model precedence.** `explicitModel = "claude-opus-4-7"`, `policyResult = {abstain: true}`, no sticky → `chosen`, tier=opus, `chosenBy: "explicit"`. Sticky now exists at opus.
- **Explicit model does NOT override a rule `{choice}`.** `explicitModel = haiku`, `policyResult = {choice: opus-model}` → chooses opus, `chosenBy: "policy"`. (Rule wins over explicit.)
- **Explicit model cannot silently downgrade past sticky.** Sticky=opus, `explicitModel=haiku`, `policyResult = abstain` → the spec says: explicit is honored only when policy abstains; but we also never downgrade below sticky without a rule. Resolve this: explicit wins over sticky (explicit is the strongest signal the client can send). Test: sticky=opus, explicit=haiku, abstain → `chosen`, tier=haiku, `chosenBy: "explicit"`. Document this inline in `policy.ts`.
- **Escalate with no sticky.** `policyResult = {escalate: 1}`, no sticky, `defaultTier = sonnet` → new tier = opus, picks first opus modelId from tierMap, `chosenBy: "escalate"`.
- **Escalate clamps at opus.** Sticky=opus, `{escalate: 2}` → stays opus.
- **Escalate with `{escalate: 0}`** from sticky=haiku → haiku (no-op escalation still refreshes sticky).
- **Abstain + sticky + within TTL** → `kind: chosen`, `chosenBy: "sticky"`, modelId = sticky.modelId.
- **Abstain + sticky + TTL expired** → `kind: abstain`, reason `"ttl-expired"`, sticky removed from store.
- **Abstain + no sticky** → `kind: abstain`, reason `"no-sticky"`.
- **TTL eviction at 2h boundary.** Entry with `lastSeenAt = t0`, lookup at `t0 + ttlMs + 1` → evicted.

## Implementation Notes

- **Purity.** `resolveStickyDecision` is the only function that mutates the store, and only on a `chosen` outcome. Tests assert this by checking `store.size()` before/after abstain calls.
- **Determinism.** `firstModelIdForTier` must iterate the tierMap in insertion order. Use a real `Map`, not a plain object — config loader (section-03) is responsible for preserving YAML insertion order when building the map.
- **No `Date.now()` inside `src/sticky/`.** Always accept `now` from the caller. This keeps tests deterministic and avoids needing a `TimeProvider` abstraction.
- **Logging.** Debug-level only. Log `sessionId` (hex), `chosenBy`, `tier`, `modelId`. Never log raw request bodies or signals here — that is section-13's job.
- **No async.** Every function in this section is synchronous. No I/O, no promises. Keeps the decision path on the proxy hot path fast.
- **File-size budget.** `store.ts` ≤ 120 lines, `policy.ts` ≤ 150 lines, `tiers.ts` ≤ 60 lines. If any file approaches 150 lines, split helpers into private functions — do not introduce new files.

## Done Criteria

- All tests in `tests/sticky/` pass under `npm test -- sticky`.
- `resolveStickyDecision` exported from `src/sticky/index.ts` (barrel file) alongside `createStickyStore`, `compareTiers`, `tierOf`.
- `section-10-wrapper` and `section-13-decision-log` can import `StickyDecision` and the store factory without touching any internal file.
- No use of `Date.now()`, no timers, no async, no external deps beyond the standard library.

## Actual Implementation Notes (post-review)

Deviations from the original plan, applied during code review:

- **No silent fallback for missing modelTiers.** The original plan left implicit behavior when `config.modelTiers` lacks an entry for a tier used by a rule (tier-shorthand `{choice: "opus"}` or `{escalate: N}`). A fallback `claude-{tier}-latest` was added then removed: those strings are not valid Anthropic aliases and would cause upstream 404s. Current behavior: **throw with a clear error message** when a required tier has no modelId. Section-03 config validation is expected to warn on sparse `modelTiers`; this is the runtime safety net.
- **`StickyStore` gains `peek(sessionId)` and `delete(sessionId)`** beyond the spec, both non-breaking. `peek` is how `resolveStickyDecision` distinguishes `ttl-expired` from `no-sticky` without mutating before deciding — it reads pre-eviction, then calls `get` to trigger eviction only if an entry was present.
- **`turnCount` semantics documented inline.** Increments on every chosen outcome (policy / explicit / escalate / sticky-hit). Never increments on abstain. Consumers (section-13 decision log) should treat this as "count of chosen routings," not "count of incoming requests."
- **Files produced:** `src/sticky/{types,tiers,store,policy,index}.ts` + `tests/sticky/{tiers,store,policy}.test.ts`. 35 tests total (tiers 9, store 9, policy 17), all passing. All file-size budgets respected (tiers ≈50, store ≈80, policy ≈130 lines).
