# Code Review — section-12 Haiku Classifier

## Critical

**C1. `AbortSignal.any` availability / error-handling asymmetry.** `AbortSignal.any` requires Node 20.3+. Fine if pinned, but there's no guard. More importantly, when the fetch is aborted via the deadline or local timer, `undici.fetch` throws an `AbortError` that is caught by the outer `try/catch` returning `null` — correct — but the `clearTimeout` in `finally` runs only if `fetchImpl` was invoked. If `AbortSignal.any` itself throws (e.g., deadline already aborted at call time), the timer leaks. Low probability but worth either checking `deadline.aborted` early or moving `clearTimeout` into the outer try.

**C2. Response body read is not timeout-bound.** The local timer is cleared in the `finally` immediately after `fetchImpl` resolves, but `await response.json()` runs afterward with no abort signal. A slow/malicious body stream can hang past `timeoutMs`. Move `clearTimeout` after `response.json()`, or keep the signal armed until parsing completes.

## Important

**I1. Spec violation — endpoint must come from config.** Section spec (line 7) says config supplies the outbound host. The factory reads `deps.endpoint` but never wires it from `ClassifierConfig`. If/when config grows an `endpoint` field, this will silently bypass the allowlist check. Either drop `deps.endpoint` entirely (since it's hard-pinned) or have it default-read from config — but don't leave a dead param that breaks the symmetry the spec calls for.

**I2. Missing test: "never both" auth headers.** Spec requires never forwarding both `authorization` AND `x-api-key`. No test asserts behavior when both are present on the incoming request. Implementation currently prefers `x-api-key` and drops `authorization` — correct but untested.

**I3. Missing test: 4xx responses.** Tests cover 5xx and network errors, but not 4xx (auth failure, bad request). Same `!response.ok` path, so it works, but spec-listed coverage should be explicit.

**I4. Missing test: `classifierCostUsd` absent when `source === 'heuristic'`.** Acceptance criterion #4 in the spec. Not directly testable here since this file only produces haiku results, but worth an explicit assertion that the field is never emitted with `undefined` on failure paths.

**I5. Non-2xx body is parsed.** `if (!response.ok) return null` is fine, but 4xx responses may include auth error details — confirm no logging of response body elsewhere leaks the forwarded key.

## Nit

**N1.** `performance.now()` default requires Node 16+ global; fine, but `now` field docs should note it returns ms, not µs.

**N2.** `HaikuUsage` marked `readonly` but typed as optional fields of `unknown`-ish origin — `toFiniteNonNegative` already handles that, so the `readonly` is cosmetic.

**N3.** `Tier` imported for `isValidHaikuJson` but literal-string-compared instead of using a shared constant. If the tier list grows, this will drift from `types.ts`.

**N4.** Test file uses `as HaikuClassifierDeps` casts liberally — the type already permits omitted optional fields, so the casts are noise.

**N5.** `summarizeRequest` silently truncates at 2000 chars with no ellipsis marker; classifier might misread truncated-code as intentional. Low-priority.

**Verdict: Warning** — C2 (body-read timeout) should be fixed before merge; the rest are non-blocking.
