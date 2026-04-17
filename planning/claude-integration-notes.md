# Integration Notes — OpenAI Review (Iteration 1)

The OpenAI (gpt-5.2) review raised 19 issues. My judgment on each, plus what got applied to `claude-plan.md`.

| # | Issue | Decision | Why |
|---|---|---|---|
| 1 | "Byte-for-byte" opacity vs. JSON reserialization on request | **Integrate.** Clarify invariant to "only semantic change is `model`". Phase 0 byte-diff tests scope to **responses + SSE only**, plus a "request forwarded equals original except `model`" assertion. | Real footgun — plan was internally contradictory. |
| 2 | "Local HTTPS" wording while URL is HTTP | **Integrate.** Rewrite to "local HTTP loopback proxy". Note that HTTPS would require cert UX not in scope. | Clarity. |
| 3 | SSE byte-for-byte vs. synthetic midstream error events | **Integrate.** Carve out explicit exception: when upstream stream fails locally, ccmux MAY emit a synthetic Anthropic-shaped SSE error event and close. Document in §2.3. | Keep UX-friendly behavior but make the carve-out explicit. |
| 4 | Missing exact hop-by-hop header list + edge cases | **Integrate.** Add exact removal list, `host` rewrite, `accept-encoding` handling, duplicate-header preservation via undici raw headers. | Implementation correctness. |
| 5 | Local privilege boundary (any local process can use proxy) | **Integrate.** Add optional `CCMUX_PROXY_TOKEN` — wrapper generates a random token, sets it in child env + requires it on proxy. Without the token the proxy also accepts (backwards-compat for `ccmux start` debug mode), but `ccmux run` always sets it. | Material security improvement, low cost. |
| 6 | Dashboard bind address not stated | **Integrate.** Dashboard server explicitly binds to `127.0.0.1`. | Defaults matter. |
| 7 | "No outbound beyond api.anthropic.com" vs. SPA loading CDN assets | **Integrate.** SPA must be fully self-contained (no external fonts, CDN scripts, remote source maps). Add a CI check. Also refine the non-negotiable: "ccmux backend makes outbound requests only to `api.anthropic.com`" (the browser is the user's). | Fixes the overstated claim. |
| 8 | Session identity stability + privacy | **Integrate.** Move to: `metadata.user_id` → random-per-connection → `HMAC_SHA256(localSalt, systemPrefix + firstUserMsgPrefix)` where `localSalt` is generated once per proxy startup and stored only in memory. Strip timestamps/paths before hashing. Document that stable hashes still enable secret-string linkability if the user opts into full logging. | Better stickiness stability + defense against cross-machine correlation. |
| 9 | Redaction still leaks via hash equality | **Integrate partially.** Document the threat model. Add a third `content: none` option for maximum privacy (drops message/tool-input fields entirely). | Small addition, clear win. |
| 10 | Classifier auth/header forwarding unspecified | **Integrate.** Classifier call explicitly reuses the intercepted request's `x-api-key`/`authorization` headers, plus `anthropic-version` and `anthropic-beta`. Outbound host allow-list: classifier may only target `https://api.anthropic.com/v1/messages`. | Was a real gap. |
| 11 | Sticky-model tier ordering + explicit-model precedence | **Integrate.** Define canonical tier order `haiku < sonnet < opus`. Custom `modelId` requires an explicit `tier` mapping in config. When Claude Code explicitly asks for a specific model, that counts as a "strong signal" that can override sticky cheaper choices. Classifier may never downgrade below the explicit request unless a rule fires. | Ambiguity that would bite during implementation. |
| 12 | Request/content hash canonicalization | **Integrate.** Define canonical form for hashing: JSON-serialize selected fields with sorted keys, exclude `model` and volatile fields (timestamps, request IDs). Use 128-bit hex (32 chars) for `requestHash` and `sessionId`. Collision analysis documented. | Removes a whole class of subtle bugs. |
| 13 | Log rotation stat-on-every-append cost | **Integrate.** Track bytes written in-process, stat only on startup + periodic (every 5 min). Single write stream with backpressure. Document durability as "best-effort" (no fsync by default). | Performance + correctness. |
| 14 | Perf budget as hard CI gate flakiness | **Integrate.** Move perf tests to a separate suite, not a hard PR gate. Gate on regressions vs. a rolling baseline (p95 > 1.5× baseline), not absolute thresholds. Measure starting after body fully received, not `onRequest`. | Pragmatic. |
| 15 | Signal extraction must handle content-as-blocks | **Integrate.** `types/anthropic.ts` models `messages[].content` as `string \| ContentBlock[]`. All extractors tolerate both shapes. Any extractor that fails degrades to "signal unknown" (the signal becomes `null`/`undefined`) and never fails the request. Add tests for both shapes. | Must-have for forward-compat. |
| 16 | Pass-through test coverage gaps (query strings, non-POST) | **Integrate.** Add fixture tests for `GET /v1/models`, query strings on `/v1/messages/count_tokens`, and non-JSON content types. | Covers real Anthropic surface. |
| 17 | `pkg` + ESM + undici risks | **Integrate.** Commit to CommonJS output for the `pkg`/`bun` binary builds (dual-package if needed). Smoke-test packaged binary in CI on every tag RC. Fallback to `bun build --compile` documented. | De-risks Phase 21. |
| 18 | Dashboard port binding + pagination | **Integrate.** Already covered by #6. Also enforce pagination limits on `/api/decisions` (`limit` max 1000, default 100). | Memory safety. |
| 19 | Cost parsing precision (usage fields vary) | **Integrate.** Explicitly document which fields are parsed for cost: `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`. Streaming path accumulates from `message_delta.usage` at stream end. Degrade gracefully (leave cost null) when absent. Record the **actual** chosen model — never infer from the request. | Accuracy of the reports that justify the whole project. |
| 20 | "Zero telemetry" policy explicitness | **Integrate.** Add: "No auto-update checks. No background fixture capture. Fixture recording is a developer-only workflow behind `CCMUX_RECORD=1`." | Makes the claim defensible. |
| 21 | Smaller edge cases (Expect: 100-continue, HTTP/2, NO_PROXY on Windows, port bind race) | **Integrate.** All four added to the edge-case test list. Proxy is explicitly HTTP/1.1; HTTP/2-prior-knowledge from clients is rejected with a clear error. Port selection uses sequential bind (try-and-catch-EADDRINUSE), not "check then bind". | Quick wins. |

## Not Integrating

None. Every point in the review was either directly actionable or a small clarification — all applied.

## Summary

Integration improves:
- **Correctness:** proxy semantics, header handling, content-block tolerance, cost field parsing.
- **Security:** local process token, dashboard loopback bind, session-ID HMAC salt.
- **Robustness:** rotation counter, sequential bind, perf as a soft gate.
- **Clarity:** HTTP vs HTTPS, tier ordering, explicit-model precedence.

The plan's skeleton and phase ordering did not need to change; the review surfaced precision issues within each phase, not structural ones.
