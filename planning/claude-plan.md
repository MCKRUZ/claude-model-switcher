# ccmux — Implementation Plan (Iteration 2, post external review)

Reader: this document is written for an engineer (or LLM) who has NOT seen the spec, research, or interview. Everything you need to implement ccmux is here.

---

## 1. Product Overview

ccmux is a single-user, Anthropic-only, **local HTTP loopback proxy** (HTTP on `127.0.0.1`, *not* HTTPS — TLS would require a cert-management UX not in scope). Claude Code is pointed at it via `ANTHROPIC_BASE_URL=http://localhost:<PORT>`. It intercepts every request to `/v1/messages`, decides which Anthropic model (Opus / Sonnet / Haiku) should actually serve the request, rewrites the `model` field, and forwards the request to `https://api.anthropic.com`. SSE responses are streamed back byte-for-byte.

The decision system has three layers, consulted in order:
1. **Policy** — YAML-configured rules over extracted request signals. Authoritative.
2. **Classifier** — a Haiku-backed complexity scorer + local heuristic fallback. Runs only when no policy rule fires.
3. **Feedback** — decision + outcome logs, analyzed offline by `ccmux tune` to suggest rule improvements.

The wrapper command `ccmux run -- claude ...` owns the proxy lifecycle — starts the proxy, injects the right environment variables (including a per-process proxy token — see §6.8), execs `claude`, tears down on exit. There is no long-running daemon in the happy path.

## 2. Non-Negotiable Properties

Any design choice that violates one of these is wrong:

1. **The only semantic change to the request body is the `model` field.** Implementation uses JSON re-serialization, which may alter non-semantic bytes (key order, whitespace, number formatting). Phase 0 byte-diff tests are scoped to **response bodies and SSE streams**, plus a "forwarded-body-equals-original-except-`model`" semantic assertion for requests.
2. **Forward-compat by default.** No strict schemas on request/response bodies. Parse for routing signals only. Unknown fields round-trip.
3. **SSE chunks are byte-for-byte** on the response hot path, with ONE explicit carve-out: when upstream streaming fails after we've already begun writing the response, ccmux MAY emit a single synthetic Anthropic-shaped SSE error event (`event: error\ndata: {...}\n\n`) and close the connection. This is documented as the only permitted synthetic SSE output.
4. **Prompt caching is the dominant cost factor.** Default to sticky-per-session model choice; escalate cheap→expensive freely, expensive→cheap only on strong signal.
5. **Zero credential ownership.** Pass auth headers through untouched.
6. **Zero outbound destinations other than `api.anthropic.com`.** Scoped to ccmux's own network calls. (The user's browser opened by `ccmux dashboard` is not constrained; ccmux itself makes no outbound calls elsewhere — no auto-update checks, no background telemetry, no fixture capture.)

## 3. Technology Choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript strict | Spec mandate |
| Runtime | Node.js 20+ | Stable undici |
| HTTP framework | Fastify | `reply.hijack()` + hooks give exact control |
| Upstream HTTP | `undici` (`dispatcher.stream` hot path; `fetch` for classifier) | Lowest-copy streaming |
| Logging | pino | Structured JSON, fast |
| Config format | YAML (`yaml` package) | Human-editable |
| File watcher | `chokidar` | Cross-platform debounced events |
| Tests | Vitest | Spec mandate |
| Mock server | Bare `node:http` fixture replayer | `@fastify/inject` doesn't model streaming |
| Dashboard frontend | Vite + React + Recharts (TypeScript) | Spec mandate |
| Dashboard server | Fastify | Reuses proxy framework |
| Binary builds | `pkg` with **CommonJS output**; fallback `bun build --compile` | pkg has sharp edges on ESM — commit to CJS for binary dist; npm package is dual-export. |
| Docker base | `node:20-alpine` | Small, standard |
| CLI arg parser | `commander` | TypeScript-friendly |

## 4. Directory Structure

```
ccmux/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md / LICENSE / Dockerfile
├── .github/workflows/
│   ├── ci.yml
│   ├── release.yml
│   └── perf.yml                 # separate soft-gate perf job
├── src/
│   ├── index.ts                 # library entry
│   ├── cli/
│   │   ├── main.ts              # commander router
│   │   ├── run.ts               # ccmux run -- ...
│   │   ├── start.ts             # ccmux start (debug / foreground)
│   │   ├── init.ts
│   │   ├── status.ts
│   │   ├── explain.ts
│   │   ├── report.ts
│   │   ├── dashboard.ts
│   │   ├── tune.ts
│   │   └── version.ts
│   ├── proxy/
│   │   ├── server.ts            # Fastify app factory, binds 127.0.0.1
│   │   ├── hot-path.ts          # /v1/messages handler (reply.hijack)
│   │   ├── pass-through.ts      # other /v1/* paths, streaming uploads aware
│   │   ├── body-splice.ts       # parse-once, edit model, JSON.stringify
│   │   ├── headers.ts           # RFC 7230 hop-by-hop filter, host rewrite
│   │   ├── upstream.ts          # undici dispatcher helpers
│   │   ├── abort.ts             # client disconnect → upstream abort
│   │   ├── errors.ts            # error → SSE-error mapper (the sole synthetic SSE)
│   │   ├── token.ts             # optional CCMUX_PROXY_TOKEN gate
│   │   └── reject-h2.ts         # reject HTTP/2-prior-knowledge
│   ├── signals/
│   │   ├── extract.ts           # request → Signals, tolerant of content blocks
│   │   ├── plan-mode.ts
│   │   ├── frustration.ts
│   │   ├── tokens.ts            # tokenizer-based estimate
│   │   ├── session.ts           # HMAC-salted sessionId derivation
│   │   ├── canonical.ts         # deterministic hash input normalization
│   │   └── types.ts
│   ├── policy/
│   │   ├── engine.ts
│   │   ├── dsl.ts               # YAML loader, Result-style errors
│   │   ├── conditions.ts
│   │   ├── tiers.ts             # haiku < sonnet < opus ordering, modelId → tier map
│   │   └── recipes/*.yaml
│   ├── classifier/
│   │   ├── index.ts             # race orchestrator
│   │   ├── haiku.ts             # forwards request auth/beta/version headers
│   │   ├── heuristic.ts
│   │   ├── cache.ts             # keyed by canonical hash (excl. model)
│   │   └── types.ts
│   ├── sticky/
│   │   ├── store.ts             # in-memory Map, TTL on access
│   │   └── policy.ts            # tier-aware sticky + explicit-model precedence
│   ├── config/
│   │   ├── schema.ts
│   │   ├── load.ts
│   │   ├── watch.ts
│   │   ├── paths.ts             # XDG resolver
│   │   └── defaults.ts
│   ├── decisions/
│   │   ├── log.ts               # pino-like writer with bounded buffer
│   │   ├── rotate.ts            # in-process byte counter, stat only at boundaries
│   │   ├── outcome.ts
│   │   ├── cost.ts              # usage-field → USD, degrades gracefully
│   │   └── types.ts
│   ├── tune/
│   │   ├── analyze.ts
│   │   ├── suggest.ts
│   │   └── diff.ts
│   ├── dashboard/
│   │   ├── server.ts            # Fastify, binds 127.0.0.1 only
│   │   ├── api.ts               # /api/* with pagination limits
│   │   ├── metrics.ts
│   │   └── frontend/            # Vite SPA, fully self-contained (no CDN assets)
│   ├── report/
│   │   └── tables.ts
│   ├── lifecycle/
│   │   ├── ports.ts             # sequential bind, no check-then-bind
│   │   ├── wrapper.ts           # sets CCMUX_PROXY_TOKEN, NO_PROXY, ANTHROPIC_BASE_URL
│   │   └── signals.ts
│   ├── logging/
│   │   └── logger.ts            # pino with auth redaction
│   ├── privacy/
│   │   └── redact.ts            # hashed | full | none
│   └── types/
│       └── anthropic.ts         # content: string | ContentBlock[] tolerant
├── tests/
│   ├── fixtures/
│   ├── replay-server.ts
│   ├── proxy/
│   ├── policy/
│   ├── classifier/
│   ├── decisions/
│   ├── cli/
│   ├── dashboard/
│   ├── e2e/
│   ├── live/                    # CCMUX_LIVE=1 only
│   └── perf/                    # separate suite, soft gate
└── scripts/
    ├── record.ts                # CCMUX_RECORD=1 fixture capture (dev-only)
    └── build-binaries.ts        # pkg wrapper + smoke test
```

## 5. Core Types

```ts
// src/signals/types.ts
export interface Signals {
  readonly planMode: boolean | null;         // null = could not determine (forward-compat)
  readonly messageCount: number;
  readonly tools: readonly string[];
  readonly toolUseCount: number;
  readonly estInputTokens: number;
  readonly fileRefCount: number;
  readonly retryCount: number;
  readonly frustration: boolean | null;
  readonly explicitModel: string | null;
  readonly projectPath: string | null;
  readonly sessionDurationMs: number;
  readonly betaFlags: readonly string[];
  readonly sessionId: string;                // 128-bit hex
  readonly requestHash: string;              // 128-bit hex, excludes `model` and volatile fields
}

// src/types/anthropic.ts
export type AnthropicContent = string | readonly ContentBlock[];
export interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly input?: unknown;
  // unknown fields permitted — forward-compat
  readonly [k: string]: unknown;
}

// src/policy/tiers.ts
export type Tier = 'haiku' | 'sonnet' | 'opus';
export const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
export function tierOf(model: string, mapping: Record<string, Tier>): Tier;

// Custom modelIds MUST appear in config.modelTiers; no implicit defaulting.
// If a custom modelId is unmapped, ccmux logs a warning and treats it as sonnet.

// src/policy/dsl.ts
export type RuleResult = { choice: ModelChoice } | { abstain: true };
export interface Rule {
  readonly id: string;
  readonly when: Condition;
  readonly then: RuleResult;
}
export type ModelChoice = Tier | { modelId: string };
```

## 6. Phase 0 — Transparent Proxy

**Goal:** Claude Code sees zero observable difference from hitting `api.anthropic.com` directly.

### 6.1 Request lifecycle (`/v1/messages`)

1. Fastify receives `POST /v1/messages`.
2. If `CCMUX_PROXY_TOKEN` is configured in the proxy (wrapper mode) and the header `x-ccmux-token` is missing or wrong → respond 401 with a simple JSON error. (`ccmux start` debug mode leaves the token unset → no gate.)
3. Reject `HTTP/2` prior-knowledge requests with 505 (Fastify is HTTP/1.1 only).
4. Verify `content-type` includes `application/json` — otherwise drop into the non-/v1/messages passthrough path (no body parse, no routing).
5. Call `reply.hijack()` to bypass Fastify serializer.
6. `headers.filterRequestHeaders()` produces outbound headers (see §6.3). `host` is rewritten to `api.anthropic.com`.
7. `body-splice.parseForSignals()` runs the body through `JSON.parse` once. Extract signal fields from the parsed object, keep reference. In Phase 0, body is re-serialized unchanged via `JSON.stringify`.
8. `upstream.streamRequest({ method, path, headers, body, signal })` invokes `undici.dispatcher.stream()`. Factory writes upstream status + `filterResponseHeaders(upstreamHeaders)` to `reply.raw` then returns it as Writable.
9. `AbortController`: `req.raw.on('close')` cancels upstream when client disconnects (<100ms target).
10. Mid-stream exception → `errors.emitSseError(reply.raw, upstreamErr)` writes a single synthetic Anthropic-shaped SSE `event: error` and calls `reply.raw.end()`.

### 6.2 Non-`/v1/messages` passthrough

All other paths under any method forward unchanged through the same hijack + undici pipeline, minus body parsing and signal extraction. Do NOT globally install a JSON body parser for these routes — they might be streaming uploads in the future. The path, method, and query string forward verbatim. A structured log line notes the endpoint.

### 6.3 Hop-by-hop and proxy-specific header handling

`headers.ts` strips exactly this set from both directions per RFC 7230 and common proxy practice:

- `connection`
- `keep-alive`
- `proxy-authenticate`
- `proxy-authorization`
- `te`
- `trailer`
- `transfer-encoding`
- `upgrade`
- Any header name listed as a token in the incoming `connection:` header value
- `content-length` is dropped on the request outbound (we re-serialize; undici will compute a new length or chunk-encode)

Additional rules:
- `host` is always rewritten to `api.anthropic.com` outbound.
- `accept-encoding` is forwarded verbatim. **No middleware decompresses or recompresses responses.** The undici dispatcher is configured with `autoSelectFamily: false` and no decompression.
- `x-ccmux-token` (if present) is stripped outbound — internal-only.
- Duplicate-header preservation: use undici's `RawHeaders` array form (`[name, value, name, value, ...]`), NOT the flattened `IncomingHttpHeaders` object, so multi-valued headers (future) round-trip correctly.

Response headers: same strip list. `set-cookie` (unlikely but possible) and all `anthropic-*` headers including `anthropic-ratelimit-*` pass through untouched.

### 6.4 Body handling

- Fastify `bodyLimit: 20 * 1024 * 1024`.
- Raw content-type parser keeps the original Buffer; we also `JSON.parse` once for signals.
- Re-serialize via `JSON.stringify(parsedBody)`. The invariant is **semantic equivalence**, not byte equality.
- Expect-`100-continue` handled: Fastify with the default parser responds to Expect automatically. Add an explicit test.

### 6.5 Streaming correctness

- `reply.raw.writeHead(statusCode, filteredHeaders)` then `reply.raw.flushHeaders()`.
- `reply.raw.socket.setNoDelay(true)` on the connection hook.
- No compression middleware on response path.
- `Content-Length` is never set by us; if upstream sets it we preserve it; otherwise chunked encoding is automatic.

### 6.6 Health + port binding

- `/healthz` returns `{status: 'ok', version, uptimeMs, mode, port}`.
- Bind `127.0.0.1` only.
- **Sequential-bind port selection** (`lifecycle/ports.ts`): try configured port → on EADDRINUSE, try port+1, +2 … up to 20 attempts. Never `net.createServer(...listen...)` → close → re-bind: that has a TOCTOU race. Bind directly and catch the error.

### 6.7 Error propagation

- **Before any response byte written:** upstream 4xx/5xx → forward status + body verbatim.
- **After first response byte:** upstream throws / socket error → emit single synthetic `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed: <redacted reason>"}}\n\n`, then `reply.raw.end()`. The message never contains auth data.
- **Client disconnect:** AbortController fires, upstream is cancelled, we write nothing further.
- Every `catch` logs via pino; nothing is swallowed.

### 6.8 Proxy token (optional local auth)

- When invoked via `ccmux run`, the wrapper generates a random 128-bit token, sets `CCMUX_PROXY_TOKEN=<token>` in the proxy process env **and** injects `ANTHROPIC_AUTH_TOKEN` → no, we can't control the child's outbound headers that way. Instead, the wrapper sets a specific header via `ANTHROPIC_BASE_URL` is insufficient; we rely on a small shim.
- Actual mechanism: the wrapper **does not set up token injection into Claude Code directly** (we don't control Claude Code's outbound headers). Instead, the proxy trusts only requests originating from 127.0.0.1 (already enforced by bind). The token is a **defense-in-depth** feature available when a user runs more than one proxy / wants process isolation. Configurable via `config.yaml`: `security.requireProxyToken: false` by default, `true` for hostile-local-environments.
- This matches what the OpenAI review suggested while staying practical — Claude Code does not expose a "please add this header to every request" knob. Document the limitation clearly.

### 6.9 Phase 0 tests

| Area | Test |
|---|---|
| Response faithfulness | Byte-equal upstream vs. ccmux for non-streaming requests (200, 400, 429) |
| SSE integrity | Fixture-replay SSE: byte-equal chunk sequence (with ≤10ms timing tolerance) |
| Request semantic equality | For every fixture: `parsed(sent_upstream) === parsed(original_request)` with possibly-different `model` |
| Auth passthrough | `x-api-key`, `authorization: Bearer` both survive |
| Forward-compat | Inject unknown top-level and nested fields; round-trip to upstream |
| Unknown SSE event | `event: weird-new-type\n` in fixture → forwarded byte-equal |
| Error propagation | 4xx, 5xx, 429 (with rate-limit headers), mid-stream error all correct |
| Abort | Client close mid-stream → upstream abort within 100ms |
| Non-JSON body | non-application/json content type → passthrough path, no crash |
| HTTP/2 prior knowledge | Rejected with 505 |
| Expect: 100-continue | No hang, works correctly |
| Query strings on passthrough | `GET /v1/models?foo=bar` → `foo=bar` preserved |
| Duplicate request headers | Both values preserved outbound |
| Port bind race | Sequential bind picks next port after collision |

## 7. Phase 1 — Policy Layer

### 7.1 Signal extraction

`signals/extract.ts` walks a parsed body and returns a frozen `Signals`. Every extractor is tolerant:

- `messages[].content` may be a `string` OR `ContentBlock[]`. Extractors flatten by joining `type === 'text'` blocks and ignoring other block types safely.
- `system` may be a string OR an array of blocks.
- If any extractor throws (unexpected shape), the specific signal becomes `null` — **request is never failed**. A warning log records the anomaly.

Individual extractors:
- `plan-mode.ts` — looks for Claude Code's plan-mode marker string across system blocks. Returns `true` | `false` | `null`.
- `frustration.ts` — scans last user message for trigger phrases. Word-boundary match. Tolerates block shapes.
- `tokens.ts` — `js-tiktoken` cl100k approx. Documented as "routing heuristic, not exact".
- `session.ts` — sessionId = `metadata.user_id` (if string, ≤256 chars, printable-ASCII) → else `hmacSha256(localSalt, canonicalInput).toHex().slice(0, 32)`. `localSalt` is generated once per proxy process (32 random bytes, in-memory only, discarded on exit). `canonicalInput` = sorted-key JSON of `{systemPrefix: first 4096 chars of joined system, firstUserPrefix: first 4096 chars of first user message, toolNames: sorted tool names}` — explicitly excludes timestamps, request IDs, file paths.

### 7.2 Canonical request hashing

`signals/canonical.ts` builds the canonical hash input for `requestHash`:
- Select fields: `{systemPrefix, userMessagesPrefix: last 3 user messages truncated to 2048 chars each, toolNames: sorted, betaFlags: sorted}`.
- Serialize with sorted keys, no whitespace.
- `sha256(canonical).toHex().slice(0, 32)` → 128-bit.
- Explicitly **excludes** `model`, request IDs, timestamps, `metadata.user_id`.
- Used for classifier cache, outcome-tagger retry detection, decision log cross-reference.

### 7.3 Rule DSL

YAML loader + evaluator as previously specified. Conditions:

```yaml
rules:
  - id: plan-mode-opus
    when: { planMode: true }
    then: { choice: opus }

  - id: short-simple-haiku
    when:
      all:
        - { messageCount: { lt: 3 } }
        - { toolUseCount: { eq: 0 } }
        - { estInputTokens: { lt: 2000 } }
    then: { choice: haiku }

  - id: frustration-escalate
    when: { frustration: true }
    then: { escalate: 1 }      # tier-relative — up 1 tier from current sticky/default
```

Supporting the relative `escalate: N` form requires the engine to know the current tier — trivial given the sticky store. Leaf predicates support `{lt,lte,eq,gte,gt,ne,in,matches}` plus booleans.

Null signals (from extractor failure) never match — they abstain from any comparison. This means `{planMode: true}` with `planMode: null` does NOT fire. Documented.

Hot-reload: chokidar watches `config.yaml`, debounce 500ms, validate+swap. Old config stays on failure.

### 7.4 Sticky-model policy

`sticky/policy.ts` rules (executed after policy, before classifier):

1. Define tier order: `haiku < sonnet < opus`. Custom `modelId` MUST map via `config.modelTiers` — unmapped gets `sonnet` with a warning log.
2. **Explicit-model precedence:** if `signals.explicitModel` is set (Claude Code explicitly asked for this model) AND no rule fired with `choice`, we honor the explicit request and skip the classifier. Explicit model is the strongest signal we have.
3. If a rule returned `{choice: X}`:
   - If tier(X) > tier(sticky): accept (escalation allowed always).
   - If tier(X) < tier(sticky): accept only if rule is tagged `allowDowngrade: true` in YAML (default false).
   - If equal: accept, update sticky timestamp.
4. If rule returned `{escalate: N}`: new tier = min(opus, tier(sticky) + N). Update sticky.
5. If rule abstained AND sticky exists AND sticky is within TTL: use sticky.
6. Otherwise: fall through to classifier (Phase 2).
7. If mode is `shadow`: all logic runs, decision is logged, but forwarded model is Claude Code's original.

Sticky storage: in-memory `Map<sessionId, {tier, modelId, createdAt, lastSeenAt, turnCount}>`. TTL eviction lazy-on-access. Size cap 10_000 (unlikely to hit).

### 7.5 Recipes

Three shipped files under `src/policy/recipes/`:
- `frugal.yaml` — aggressive Haiku, permissive escalation.
- `balanced.yaml` — default for `ccmux init`. Plan→Opus, tiny→Haiku, retries→escalate, otherwise sticky-sonnet.
- `opus-forward.yaml` — default Opus, only trivially-short → Haiku.

### 7.6 `mode: shadow`

Config-only toggle (no CLI flag). In shadow mode, `body-splice` does NOT rewrite `model` — but the decision is logged with `forwarded_model` (what Claude Code asked for) and `would_have_routed` (what ccmux would have chosen).

### 7.7 `ccmux explain <request.json>`

Loads JSON, runs extract + policy + (optionally --classifier) offline. Prints which rule fired (if any), sticky state, final decision, reasoning path. Never hits the network.

## 8. Phase 2 — Classifier Layer

### 8.1 Interface

```ts
export interface Classifier {
  classify(input: ClassifierInput, deadline: AbortSignal): Promise<ClassifierResult>;
}
```

`classifier/index.ts` owns `RaceClassifier`:
- Fires `haiku.classify()` and `heuristic.classify()` in parallel.
- Resolves with the first to satisfy `confidence >= threshold` (haiku ≥0.6, heuristic ≥0.4, configurable).
- If Haiku times out (800ms default), resolve with heuristic result.
- Records `source: 'haiku' | 'heuristic'` in the result.

### 8.2 Haiku classifier

- Uses `undici.fetch` to `https://api.anthropic.com/v1/messages` — **outbound host allow-listed to exactly this URL**. Any attempt to configure a different origin throws at startup.
- Headers: reuses the intercepted request's `x-api-key` OR `authorization` (whichever was present), plus `anthropic-version` and `anthropic-beta` from the intercepted request. **Never uses a different auth mechanism.**
- Body: the classifier's own small prompt with `cache_control` on a stable prefix so the classifier itself benefits from caching.
- Output: strict JSON `{complexity: 0-10, suggestedModel: "opus"|"sonnet"|"haiku", confidence: 0-1, rationale?: string}`.
- Abort on deadline.
- Model default: `claude-haiku-4-5-20251001`, configurable in `config.yaml`.

### 8.3 Heuristic classifier

Pure TypeScript, deterministic. Features weighted via hand-tuned table:
- Token count buckets (< 500, 500-2k, 2-8k, > 8k)
- Tool breadth (number of distinct tool categories)
- Code-block density in last message
- Imperative vs question marker
- File-path count

Returns `{score, suggested, confidence}`. Always finishes in <1ms.

### 8.4 Result cache

`Map<requestHash, ClassifierResult>` (requestHash is the canonical hash from §7.2, so it excludes `model`). TTL 5 min. Skip cache when `confidence < 0.5`.

## 9. Phase 3 — Feedback Loop

### 9.1 Decision log writer

- Single `fs.createWriteStream` per rotation file, `{ flags: 'a', highWaterMark: 64KB }`.
- Writes check `stream.write()` return; on `false`, pause enqueuing until `'drain'`. Bounded queue max 1000 records; dropped records logged.
- Durability: best-effort (no `fsync` by default). Optional `logging.fsync: true` in config for paranoid users.
- Rotation: **in-process byte counter** tracks file size. Stat only at startup + every 5 min (low cost). On size-based strategy, rotate when counter ≥ limit. On daily strategy, rotate when the current filename-date differs from now.
- Atomic rotate: Windows-compatible rename (`fs.renameSync` in a try; fall back to copy+truncate if rename fails while file is open).

Record shape:

```json
{
  "timestamp": "2026-04-17T14:00:00Z",
  "session_id": "...",
  "request_hash": "...",
  "extracted_signals": { ... },
  "policy_result": { "rule_id": "short-simple-haiku" } | { "abstain": true },
  "classifier_result": { "score": ..., "suggested": "haiku", "confidence": 0.82, "source": "haiku", "latencyMs": 512 } | null,
  "sticky_hit": true | false,
  "chosen_model": "claude-haiku-4-5-20251001",      // the ACTUAL model used on upstream
  "chosen_by": "policy" | "classifier" | "fallback" | "sticky" | "explicit" | "shadow",
  "forwarded_model": "...",                          // = chosen_model in live, = client-requested in shadow
  "upstream_latency_ms": ...,
  "usage": { "input_tokens": ..., "output_tokens": ..., "cache_read_input_tokens": ..., "cache_creation_input_tokens": ... } | null,
  "cost_estimate_usd": ... | null,
  "mode": "live" | "shadow"
}
```

### 9.2 Cost accounting

`decisions/cost.ts`:
- Parses **only these** fields from upstream response: `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming path accumulates usage from `message_delta.usage` emitted at stream end.
- If any field absent, corresponding cost component is `null` — total cost falls back to `null` rather than silently under-reporting.
- Records the **actual upstream model** (from the response `model` field), never inferred from the request.

### 9.3 Outcome tagging

Same logic as before — appends to `outcomes.jsonl` sidecar keyed by `request_hash`. Tags: `continued`, `retried`, `frustration_next_turn`, `abandoned`.

### 9.4 Privacy

`config.logging.content` has THREE modes:
- `hashed` (default) — message strings and tool `input` fields replaced with `sha256(content).slice(0, 12)`. Equality linkable — documented in threat model.
- `full` — everything logged. Auth headers still redacted.
- `none` — messages and tool inputs dropped entirely from the log record; only signals and metadata remain.

Documented threat model snippet: "With `hashed`, two identical secrets become the same 12-char hash and are linkable across log entries. Use `none` on shared machines."

### 9.5 `ccmux tune`

Unchanged from v1 of the plan: analyze log + outcomes, surface weak rules, emit unified diff, never auto-edit.

## 10. Phase 4 — Observability

### 10.1 `ccmux report` CLI

Unchanged: terminal tables from filter→aggregate→render pipeline. Flags `--since`, `--group-by`, `--format`.

### 10.2 SPA dashboard

- Server (`dashboard/server.ts`) binds **`127.0.0.1` only**, default port 8788 with sequential fallback.
- Serves the Vite-built SPA statically.
- `/api/summary`, `/api/decisions`, `/api/costs` with pagination enforced: `limit` default 100, max 1000. Large `since` windows stream-aggregate rather than load whole log into memory.
- SPA build is **fully self-contained**: no remote fonts, no CDN scripts, no remote source maps. CI check scans `src/dashboard/frontend/dist/` for any `http://` / `https://` references except to `localhost:*` and asserts none.
- Opens the user's default browser to `http://127.0.0.1:<port>`. The browser itself is the user's — ccmux makes no other outbound calls.

### 10.3 Metrics

`/metrics` endpoint on the dashboard server (not proxy — keeps hot path clean).

## 11. Wrapper Process (`ccmux run`)

`lifecycle/wrapper.ts`:

1. Parse config.
2. Start proxy on chosen port.
3. Wait for `/healthz` OK.
4. Build child env:
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
   - `NO_PROXY=127.0.0.1,localhost` (comma-separated, works on Unix + Windows tooling that respects it; also set `NOPROXY` and `no_proxy`)
   - Existing auth env (`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, etc.) preserved
5. Spawn child with `stdio: 'inherit'`.
6. SIGINT/SIGTERM → forward to child → wait for exit → stop proxy → flush logs → exit with child's code.

`ccmux start [--foreground]` is a debug sibling: no child spawn, PID file in `~/.config/ccmux/ccmux.pid`, suitable for manual testing.

## 12. Distribution

Four artifacts from `.github/workflows/release.yml`:

1. **npm** — `npm publish`. Dual-export (ESM main + CJS for pkg).
2. **Standalone binaries** — `pkg` builds linux/macos/win × x64/arm64 against the CJS entry. **Smoke-test each binary in CI:** start it, make a mock-upstream request through it, verify SSE correctness. Fail the release if any binary fails its smoke.
3. **Docker** — multi-stage, `node:20-alpine`.

Binary build fallback: if `pkg` breaks (often does with new Node versions / native deps), switch to `bun build --compile` — documented in `scripts/build-binaries.ts` as a flag.

## 13. Configuration Reference

```yaml
# ~/.config/ccmux/config.yaml

port: 8787
mode: live                      # or "shadow"

security:
  requireProxyToken: false      # if true, proxy only accepts requests with x-ccmux-token

rules:
  - id: plan-mode-opus
    when: { planMode: true }
    then: { choice: opus }

classifier:
  enabled: true
  model: claude-haiku-4-5-20251001
  timeoutMs: 800
  confidenceThresholds:
    haiku: 0.6
    heuristic: 0.4

stickyModel:
  enabled: true
  sessionTtlMs: 7200000

modelTiers:                     # required for any custom modelId
  claude-opus-4-7: opus
  claude-sonnet-4-6: sonnet
  claude-haiku-4-5-20251001: haiku

logging:
  content: hashed               # hashed | full | none
  fsync: false
  rotation:
    strategy: daily             # daily | size | none
    keep: 30
    maxMb: 10

dashboard:
  port: 8788

pricing:
  claude-opus-4-7: { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 }
  # ...
```

## 14. Error Handling Strategy

- **Expected failures:** Result-style, surfaced with clear CLI messages and non-zero exit.
- **Unexpected failures:** thrown + logged; in mid-stream cases emit the one permitted synthetic SSE error event and close.
- **Signal extraction failures:** never fail the request — degrade signal to `null`.
- **Never swallow.** Every catch logs or re-throws.

## 15. Performance Budget

- Proxy overhead target: **p95 < 50ms**, measured from "full request body received" to "first byte written to reply", **excluding** classifier latency and upstream time.
- Enforced as a **soft gate** in `.github/workflows/perf.yml`: runs nightly + on demand, not on every PR. Compares against a rolling 7-day baseline; flags regressions > 1.5× baseline. Perf test lives in `tests/perf/`.
- Classifier latency reported separately in the decision log.

## 16. Cross-Cutting Requirements

| Concern | Solution |
|---|---|
| Windows | `path.join`, `path.resolve` at boundaries. XDG path cross-platform. No bash in runtime. |
| Auth redaction | pino `redact: ["req.headers.authorization", "req.headers['x-api-key']", "req.headers['x-ccmux-token']"]` |
| Keep-alive pool | Single `undici.Agent` for `api.anthropic.com` reused across requests |
| Graceful shutdown | SIGINT/SIGTERM → stop accept → wait up to 30s for in-flight → force close |
| TypeScript | `strict: true`, `noUncheckedIndexedAccess: true`. `any` only at JSON boundaries with `// anthropic-forward-compat: <reason>` |
| Immutability | `readonly` everywhere, `functional/immutable-data` lint |
| HTTP version | HTTP/1.1 only; reject HTTP/2 prior knowledge |
| No phone-home | No auto-update checks. Version check is manual only. No background fixture capture (dev-only, `CCMUX_RECORD=1`). |

## 17. Testing Strategy

### 17.1 Record/replay
- `CCMUX_RECORD=1` (dev only) captures `tests/fixtures/<scenario>/{request.json, response.raw, timing.json}` against live Anthropic.
- `tests/replay-server.ts` replays with realistic inter-chunk delays on a real TCP socket.

### 17.2 Test groupings

| Suite | Focus |
|---|---|
| `tests/proxy/` | Phase 0 faithfulness, SSE, auth, forward-compat, errors, edge cases (§6.9 table) |
| `tests/policy/` | Rule engine, DSL loader, tier ordering, explicit-model precedence, content-blocks tolerance |
| `tests/classifier/` | Race, timeout, cache, header forwarding, outbound host allowlist |
| `tests/decisions/` | Log rotation (byte counter correctness), outcome tagging, redaction modes (hashed/full/none), cost field parsing |
| `tests/cli/` | Each subcommand |
| `tests/dashboard/` | API endpoints, pagination limits, self-contained asset check |
| `tests/e2e/` | End-to-end replay server + claude stub |
| `tests/live/` | `CCMUX_LIVE=1` only, real Anthropic |
| `tests/perf/` | Separate suite, soft gate |

Coverage: 80% line except `src/dashboard/frontend/` (informational only).

## 18. Implementation Order (Section Split Plan)

Section files under `planning/sections/`:

1. `section-01-repo-skeleton.md`
2. `section-02-logging-paths.md`
3. `section-03-config.md`
4. `section-04-proxy-phase0.md`
5. `section-05-cli-start-and-ports.md`
6. `section-06-config-watcher.md`
7. `section-07-signals.md`
8. `section-08-policy.md`
9. `section-09-sticky-model.md`
10. `section-10-wrapper.md`
11. `section-11-classifier-heuristic.md`
12. `section-12-classifier-haiku.md`
13. `section-13-decision-log.md`
14. `section-14-outcome-tagger.md`
15. `section-15-report-cli.md`
16. `section-16-tune.md`
17. `section-17-dashboard-server.md`
18. `section-18-dashboard-spa.md`
19. `section-19-init-and-recipes.md`
20. `section-20-explain.md`
21. `section-21-release-ci.md`
22. `section-22-docs.md`

Dependencies (simplified):
- 01 → 02, 03
- 03 → 04
- 04 → 05, 06
- 04 → 07
- 07 → 08 → 09 → 10
- 09 → 11, 12 (classifier layer)
- 09 → 13 → 14
- 13 → 15, 16
- 13 → 17 → 18
- 08 → 19
- 08 → 20
- all implementation sections → 21, 22

Each section ships with TDD stubs (see `claude-plan-tdd.md`).

## 19. Risks & Open Items

| Risk | Mitigation |
|---|---|
| Anthropic changes SSE shape | Opaque passthrough is the mitigation. Re-capture fixtures weekly (dev workflow). |
| Claude Code adds OAuth refresh requirements on the proxy | Monitor; add explicit refresh passthrough if needed. |
| Haiku classifier accuracy | Heuristic floor; `classifier.enabled: false` if Haiku consistently underperforms. |
| `pkg` fails on new Node versions | `bun build --compile` fallback; smoke test binaries in CI. |
| YAML hot-reload races with in-flight request | Each request captures config snapshot at start; reload affects only subsequent requests. |
| Prompt-cache TTL changes | Read from config; document update procedure. |
| Secret-string hash linkability in logs | `content: none` option; documented threat model. |
