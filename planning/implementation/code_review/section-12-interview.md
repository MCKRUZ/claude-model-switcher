# Code Review Interview — section-12

## User decisions

- **I1 (endpoint param)** — KEEP. User opted to retain the optional `deps.endpoint` parameter and its allowlist check. Rationale: if `ClassifierConfig` ever grows an endpoint field, the safety check is already wired up. Action: add a clarifying comment so future readers understand the param is intentional.

## Auto-fixes (no user input needed)

- **C1 (timer leak on early-aborted deadline)** — Apply: check `deadline.aborted` at entry and short-circuit to `null`; this also prevents `AbortSignal.any` from being called against an already-aborted signal.
- **C2 (response body read not timeout-bound)** — Apply: keep the timer armed past `fetchImpl` until `response.json()` completes; clear it in the outermost `try/finally`.
- **I2 (test gap: both auth headers present)** — Apply: add a test asserting that when both `x-api-key` and `authorization` are forwarded on the incoming request, only `x-api-key` is sent and `authorization` is dropped.
- **I3 (test gap: 4xx response)** — Apply: add a test that an HTTP 401 (auth failure) returns `null` and never reads the response body.

## Let go

- **I4 (heuristic-source classifierCostUsd test)** — Heuristic source is covered by `tests/classifier/heuristic.test.ts`; out of scope for the Haiku-only test file.
- **I5 (4xx body leakage)** — Implementation already checks `if (!response.ok) return null;` BEFORE calling `response.json()`. The forwarded auth key never appears in any logged response body. No change needed.
- **N1–N5** — Cosmetic; no behavior impact. Leaving as-is.
