# Openai Review

**Model:** gpt-5.2
**Generated:** 2026-04-17T10:48:34.353422

---

## 1) Core proxy semantics vs “only mutate model” (Phase 0/1, §§2, 6, 6.4)

### Footgun: JSON reserialization is *not* “all other bytes opaque”
You state **Model field is the only mutation** (§2.1) and “opaque passthrough” everywhere, but in §6.1/§6.4 you parse JSON and later (Phase 1+) serialize via `JSON.stringify(parsedObject)`. Even if you only change `model`, reserialization can change:
- object key order
- whitespace/newlines
- escaping (e.g. `\u2028`)
- number formatting
- presence/absence of insignificant JSON differences

That violates “all other bytes … opaque passthrough” if interpreted literally, and it will break the Phase 0 “diff byte-by-byte” test for requests unless your fixture diffs are only for responses.

**Actionable fixes:**
- Clarify the invariant: “Only semantic change is `model`” rather than “only mutation byte-for-byte” on the request path.
- Or implement a *surgical JSON splice* that preserves original bytes except for the `model` value (hard, but doable if you constrain to UTF-8 JSON and a single top-level `model` key).
- Update Phase 0 tests to explicitly scope byte-for-byte diffs to **responses** and **SSE**, and to “request forwarded equals original except `model`” once routing is enabled.

### Edge case: request body may not be JSON
Anthropic endpoints are JSON, but you also route “any other path under `/v1/*`” (§6.2) with passthrough. Some may send non-JSON, gzipped bodies, or unusual content-types.

**Actionable fixes:**
- In `/v1/messages`, enforce `content-type` includes `application/json` before attempting parse; otherwise passthrough without routing (or error).
- In `pass-through.ts`, never install a global raw-body parser that assumes JSON; ensure it doesn’t eagerly consume bodies and break streaming uploads.

---

## 2) HTTPS vs HTTP ambiguity (Overview, §1)

You call it a “local HTTPS proxy” but `ANTHROPIC_BASE_URL=http://localhost:<PORT>` is HTTP. That mismatch affects:
- security expectations (local plaintext vs TLS)
- Claude Code behavior if it ever requires HTTPS base URLs
- certificate management if you truly mean HTTPS

**Actionable fixes:**
- Decide explicitly: **HTTP loopback only** (most likely) and correct wording everywhere.
- If you truly want HTTPS locally, you need cert generation/trust UX and additional failure modes; plan does not cover this.

---

## 3) SSE “byte-for-byte, no buffering” vs error mapping (Phase 0, §6.1 step 7, §2.3)

`errors.ts` “emits a well-formed Anthropic-shaped SSE error event if the response had already begun streaming” (§6.1.7). That directly violates “SSE chunks are byte-for-byte. No event-level parsing” (§2.3) in midstream error cases.

**Actionable fixes:**
- Pick one invariant:
  - **Strict passthrough**: if upstream breaks midstream, just close the client socket (or propagate TCP FIN/RST) with no synthetic SSE.
  - **UX-friendly synthetic SSE**: keep it, but amend §2.3 to allow *synthetic terminal error events only when upstream stream fails locally* (and document exact behavior).
- Add tests covering: upstream half-close, upstream reset, and local timeout while streaming.

---

## 4) Hop-by-hop header handling + undici streaming gotchas (Phase 0, §6.3, §6.5, §16)

### Missing: complete hop-by-hop + proxy header rules
You mention filtering hop-by-hop headers, but don’t specify the exact list. In Node/Fastify/undici proxying, wrong header forwarding can cause hangs or broken SSE.

**Actionable checklist for `headers.ts`:**
- Remove request hop-by-hop: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, plus any header named by `Connection: ...` tokens.
- Remove/adjust: `content-length` if body is reserialized; otherwise it will mismatch.
- Be careful with `accept-encoding`: if client requests gzip and upstream returns gzip, you’re fine if you truly stream bytes; but if any layer auto-decompresses, you’ll corrupt “byte-for-byte”.
- Ensure `host` is set correctly for upstream (`api.anthropic.com`)—don’t forward `localhost` host header.

### Response headers: avoid leaking upstream hop-by-hop
Same removal list applies. Also be cautious about:
- `set-cookie` (probably none, but passthrough)
- `www-authenticate` etc.
- multiple header values: Node’s header objects can collapse them; you need to preserve duplicates if relevant (not common for Anthropic, but plan claims forward-compat).

**Actionable fix:** use undici’s raw headers array where possible, not `IncomingHttpHeaders` object, to preserve multiple headers.

---

## 5) “Zero credential ownership” vs local attack surface (Security, §§2.5, 6.6, 11)

Binding to `127.0.0.1` helps, but any local process can hit the proxy and ride the user’s credentials (because headers are forwarded untouched). This is still “credential ownership: zero”, but it’s a **local privilege boundary** issue.

**Actionable mitigations:**
- Add an optional **shared secret** header between wrapper and proxy (e.g. `CCMUX_PROXY_TOKEN` env injected into child, proxy requires `x-ccmux-token`). This prevents unrelated local processes from using the proxy.
- At minimum, add a prominent doc note: “any local process can use the proxy while it’s running”.

Also consider **CSRF-like** risk via browser if CORS is permissive. Fastify default CORS is off, but ensure you never enable it on proxy port.

---

## 6) “Only outbound network destination is api.anthropic.com” conflicts with dashboard + browser opening (Non-negotiables, §2.6, Phase 4)

- `ccmux dashboard` “opens the browser” (§10.2). That can trigger network calls (browser homepages, extensions). Not ccmux’s fault, but the non-negotiable reads broader than your implementation can guarantee.
- Prometheus scraping is inbound, fine.
- If the SPA loads fonts/CDNs (Vite default templates sometimes do), that violates §2.6.

**Actionable fixes:**
- Explicitly constrain: “ccmux backend makes outbound requests only to api.anthropic.com.” (not the user’s browser)
- Ensure the SPA is fully self-contained: no external CDN assets, no remote source maps, no remote icons.

---

## 7) Session identity + privacy leaks (Signals, §7.1; Privacy, §9.3)

### SessionId derivation is unstable and may leak sensitive structure
`sha256(system_serialized + firstUserMessage).slice(0,16)`:
- will change if system prompt contains volatile content (timestamps, paths), destroying stickiness
- ties session identity to potentially sensitive content (even hashed, it’s a stable pseudonymous identifier derived from private text)

**Actionable fixes:**
- Prefer a random ephemeral session id cached per running proxy instance, keyed by `metadata.user_id` if present, else by **connection/process** identity.
- Or if you must derive from content, salt it with a locally-stored random secret to prevent cross-machine correlation: `HMAC_SHA256(localSalt, system+firstMsg)`.

### Redaction still leaks via lengths and hashes
Hashing message content preserves equality; a repeated secret string becomes linkable. That may be acceptable, but call it out.

**Actionable:** document threat model; optionally offer `content: none` (drop message/tool inputs entirely) for maximal privacy.

---

## 8) Classifier call violates prompt/headers constraints + may break “auth passthrough” expectations (Phase 2, §8.2)

You’ll be making an additional Anthropic call (classifier) using the user’s credentials (since you don’t own keys). But the plan doesn’t specify:
- which auth header is used (`x-api-key` vs `authorization`)
- how you obtain it if Claude Code used one or the other
- whether you forward *all* headers (beta flags, anthropic-version, etc.) to classifier

**Actionable fixes:**
- Define an explicit `UpstreamAuth` extraction: pass through the same auth header(s) from the intercepted request to the classifier request.
- Ensure you copy required Anthropic headers: `anthropic-version`, `anthropic-beta`, and any future required headers (forward-compat issue).
- Add a strict outbound host allowlist for classifier: must still only target `https://api.anthropic.com/v1/messages`.

Also: classifier prompt caching: you mention `cache_control` usage. That is a mutation of the classifier request body; fine, but ensure it doesn’t accidentally get applied to the main request or leak into “only model mutation”.

---

## 9) Sticky-model escalation logic ambiguity (Sticky, §7.3; Non-negotiable §2.4)

Your sticky rules talk about “escalation from sticky” and “allows that choice”, but you haven’t defined:
- the model ordering when `ModelChoice` can be `{modelId: string}`
- how “explicitModel” from Claude Code interacts with sticky/policy
- “escalate one tier from default” appears in recipe example, but “default” isn’t formally defined

**Actionable clarifications to add:**
- Define a canonical tier order: `haiku < sonnet < opus`, and treat unknown `modelId` as “sonnet-tier unless configured otherwise” or require mapping in config.
- Decide precedence: if Claude Code explicitly asked for Opus, do you ever downgrade? (Non-negotiable suggests expensive→cheap only on strong signal, but explicit request is a strong signal.)
- Define “default” as either: Claude Code’s requested model, or a configured baseline (e.g. Sonnet).

---

## 10) Request hashing and cache keys (Signals §5, Classifier cache §8.4, Decision log §9)

`requestHash` derived from “system + last N messages + tools” is mentioned in multiple places but not specified precisely:
- canonicalization (JSON stringify order?)
- inclusion of tool inputs? (privacy!)
- inclusion of model? (would cause cache misses when routing changes)
- whether it includes file references, metadata, beta flags

**Actionable fixes:**
- Specify a stable canonical representation for hashing (e.g. normalized minimal object with selected fields, stable key ordering).
- Ensure it excludes any fields that you mutate (`model`) and excludes volatile fields (timestamps).
- Document collision risk of short hashes (you slice to 16 chars for sessionId and 12 for content hash). For requestHash you didn’t specify length—use at least 128 bits of hex if you use it as a Map key and logfile join key.

---

## 11) Logging/rotation correctness and durability (Phase 3, §9.1)

“Append is non-blocking (buffer + flush)” is a common source of data loss on crash, and rotation “stat on every append” can become costly at high QPS (even single-user can burst with tool loops).

**Actionable fixes:**
- Use a single write stream with backpressure handling; don’t build an unbounded buffer.
- Make durability explicit: either “best-effort” or provide `fsync` option (off by default).
- Rotation: avoid `stat` every append; track bytes written in-process and stat only on startup / periodic timer.
- Ensure atomic rotate with Windows semantics (rename behavior differs).

---

## 12) Performance budget test is underspecified and possibly flaky (Phase 15)

The “delta between onRequest and first chunk written” will be extremely noisy under CI load and across OSes. Also, “excluding classifier time” is easy, but you also parse body and do tokenization; those are on-path.

**Actionable fixes:**
- Benchmark as a separate perf test suite, not a hard CI gate, or gate only on *regressions relative to baseline*.
- Measure multiple iterations, warm-up, and assert on a generous threshold or use percentile over many runs locally.
- Ensure the metric starts after body is fully received vs. onRequest (otherwise bigger prompts inflate “proxy overhead” unfairly).

---

## 13) Forward-compat vs partial parsing risks (Signals extraction, §7.1)

You plan to parse request and then traverse fields for signals. Edge cases:
- `messages` may include content as arrays of blocks, not strings (Anthropic does this)
- tool calls / tool inputs may have nested structures
- Claude Code may send `system` as array blocks, not a string

If your extractors assume strings, you’ll throw and violate “forward-compat by default”.

**Actionable fixes:**
- In `types/anthropic.ts`, explicitly model `messages[].content` as `unknown` and implement robust extraction that can handle:
  - string content
  - array of blocks with `{type,text}` etc.
- Any extractor failure should *degrade to “signal unknown/zero”* and not fail the request (unless you choose to be strict). Add that to error handling strategy.

---

## 14) Pass-through of non-/v1/messages endpoints might miss required behavior (Phase 0, §6.2)

Claude Code (or future Anthropic tooling) may call:
- `/v1/models`
- `/v1/messages/count_tokens` (if exists/added)
- beta endpoints under `/v1/…` that require special headers

Your passthrough is fine, but ensure:
- you forward **method**, **query string**, and **path** exactly (including trailing slashes)
- you don’t accidentally parse bodies for these routes (some might be streaming uploads in future)

**Actionable:** add a fixture test for query strings and non-POST methods.

---

## 15) Packaging risks: `pkg`, ESM, undici, and snapshot filesystem (Distribution §12, Risks §19)

Node 20 + TypeScript strict typically implies ESM in many projects; `pkg` historically has sharp edges with ESM, dynamic requires, and undici internals.

**Actionable fixes:**
- Decide module system early (CJS vs ESM) with `pkg` constraints tested in Phase 1–2, not late.
- Add a release-candidate “smoke test” that runs the packaged binary and exercises:
  - proxy hot path streaming
  - dashboard asset serving from snapshot FS
  - config loading from disk paths

---

## 16) Dashboard/API security + data exposure (Phase 4, §10)

Dashboard binds to a port (default 8788) but you didn’t state bind address. If it binds to `0.0.0.0`, it exposes decision logs (even redacted) to the LAN.

**Actionable fixes:**
- Bind dashboard server to `127.0.0.1` by default, mirroring proxy.
- Consider requiring the same local token suggested above, or at least randomize dashboard port and print it.
- Make sure `/api/decisions` enforces limits and pagination to avoid memory blowups.

---

## 17) Ambiguity: “prompt caching is dominant cost factor” but you don’t model cache behavior precisely (Non-negotiable §2.4, Reports/Metrics §10)

You plan to compute cost breakdown including cacheRead/cacheCreate, but unless you parse Anthropic usage fields precisely, you may misattribute costs:
- usage might include cached token counts in separate fields (varies by API version)
- not all responses include cache info
- streaming usage fields can arrive at end

**Actionable fixes:**
- Define exactly which response fields you will parse for cost accounting (per Anthropic docs at implementation time), and degrade gracefully when absent.
- In shadow/live modes, ensure the model you *actually used* is recorded; don’t assume it from request.

---

## 18) “Zero telemetry” vs update checks / weekly fixture capture (Risks §19)

You mention “Tests on a fresh fixture-capture run every week.” That implies someone or something runs recording against real upstream. That’s fine, but ensure the product itself never auto-phones-home.

**Actionable:** explicitly state “No auto-update checks, no background fixture capture; fixture capture is a developer workflow only.”

---

## 19) Smaller correctness edge cases to add tests for

- Client sends `Expect: 100-continue` (Node/undici interactions can hang).
- Very large bodies near 20MB: ensure no double-buffering (raw buffer + parsed object) causes memory spikes.
- HTTP/2: Claude Code may use fetch/undici and negotiate h2 to localhost? Fastify is HTTP/1.1 by default. If client tries h2 prior knowledge, it will fail.
  - Action: explicitly document HTTP/1.1 only, or add h2 support (probably not needed, but clarify).
- `NO_PROXY` formatting on Windows (semicolon vs comma in some tooling).
- Port fallback race: between finding a free port and binding, another process can take it.
  - Action: just try bind sequentially; don’t “check then bind”.

---

## Summary of biggest architectural mismatches to resolve

1. **Request byte-for-byte opacity vs JSON reserialization** (§2.1 vs §6.4): clarify or implement true byte splice.
2. **SSE byte-for-byte vs synthetic midstream SSE error** (§2.3 vs §6.1.7): pick one or carve out exception.
3. **Local security boundary** (any local process can use proxy): add optional shared-secret token.
4. **Signal extraction forward-compat**: must handle non-string content blocks robustly to avoid breaking on new Anthropic shapes.
5. **Dashboard bind + exposure**: bind to loopback, enforce pagination/limits.

If you address those explicitly in the plan (with concrete precedence rules and failure modes), the implementation becomes much less footgun-prone while staying aligned with your non-negotiables.
