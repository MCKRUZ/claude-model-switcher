# section-07-signals

## Scope

Implement signal extractors that convert a parsed Anthropic `/v1/messages` request body into a frozen `Signals` object. Signals are the inputs to the policy engine (section-08) and classifier (sections 11/12). This section is pure, synchronous, in-process — no I/O, no network. Every extractor MUST be tolerant of schema variation and MUST degrade to `null` on unexpected input rather than failing the request.

## Dependencies

- **section-04-proxy-phase0** — provides the hot path that parses the request body once and hands the parsed object to `signals/extract.ts`. This section only provides the `parseForSignals()` implementation; it does not wire it into the proxy.

## Background Context

The decision system in ccmux has three layers (policy → classifier → feedback). Signals are the shared input shape consumed by all three. Core principles:

- **Forward-compat by default.** No strict schemas on request/response bodies. Parse for routing signals only. Unknown fields round-trip.
- **Signal extraction failures never fail the request.** Degrade the specific signal to `null` and log a warning.
- **Tolerant of content-block polymorphism.** `messages[].content` and `system` may be `string` OR `ContentBlock[]`. Unknown block types are ignored safely.
- **No credential ownership.** Extractors never touch auth headers.

## Files to Create

Directory layout under `src/signals/`:

```
src/signals/
├── types.ts          # Signals interface + ContentBlock shape (shared)
├── extract.ts        # top-level: parsedBody → Signals
├── plan-mode.ts      # plan-mode marker detection
├── frustration.ts    # frustration-phrase detection on last user message
├── tokens.ts         # js-tiktoken cl100k token estimate
├── tools.ts          # tool name list + tool_use count + file-ref count
├── messages.ts       # content-block flatten helpers (shared utility)
├── retry.ts          # retry count via requestHash repetition in session
├── session.ts        # sessionId derivation (HMAC local-salt)
├── canonical.ts      # requestHash canonical serialization
└── beta.ts           # anthropic-beta comma-split → sorted array
```

Supporting shared types (may already exist from section-01 stub):

```ts
// src/types/anthropic.ts
export type AnthropicContent = string | readonly ContentBlock[];
export interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly input?: unknown;
  readonly [k: string]: unknown;  // unknown fields permitted — forward-compat
}
```

## Core Type

`src/signals/types.ts` MUST export this exact shape (consumed verbatim by section-08 and beyond):

```ts
export interface Signals {
  readonly planMode: boolean | null;         // null = could not determine
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
  readonly requestHash: string;              // 128-bit hex
}
```

The returned object MUST be frozen (`Object.freeze`). The `tools` and `betaFlags` arrays MUST also be frozen.

## Extractor Specifications

### `extract.ts` (top-level orchestrator)

```ts
export function extractSignals(
  parsedBody: unknown,
  headers: Readonly<Record<string, string | readonly string[]>>,
  sessionContext: { createdAt: number; retrySeen: (hash: string) => number },
  logger: Logger
): Signals;
```

- Calls each extractor in isolation. Each call is wrapped in try/catch. On throw: log a `warn` with the extractor name + anomaly, set the specific signal to its null-equivalent (`null` for nullable fields, `0` for counts, `[]` for arrays), and continue.
- Orchestrator itself MUST NOT throw.
- Returns `Object.freeze({...})`.

### `plan-mode.ts`

- Looks for Claude Code's plan-mode marker string across `system` content, whether `system` is a string or a `ContentBlock[]`.
- Returns `true | false | null` (null when the marker mechanism is indeterminate).

### `frustration.ts`

- Scans the **most recent user message** for trigger phrases: "no", "stop", "why did you", "that's wrong" — case-insensitive, word-boundary match.
- Tolerates both string and `ContentBlock[]` shapes (flatten via `messages.ts` helper, join `type === 'text'` blocks).

### `tokens.ts`

- Uses `js-tiktoken` cl100k encoding on the joined text of system + all messages.
- Documented inline as "routing heuristic, not exact".
- Returns `number` (zero on empty input).

### `tools.ts`

- `tools` — names from the request's `tools` array (sorted, deduped, frozen).
- `toolUseCount` — count of `type === 'tool_use'` blocks across assistant messages.
- `fileRefCount` — count of tool_use blocks whose tool name matches `read_file | write | edit` (or their current Anthropic-canonical equivalents). Match by exact name.

### `messages.ts` (shared utility)

- `flattenText(content: AnthropicContent): string` — joins `type === 'text'` block `text` fields with `\n`; ignores other block types; returns the string directly if `content` is already a string.
- `lastUserMessage(messages: readonly unknown[]): string | null` — returns flattened text of the last message whose `role === 'user'`, else `null`.

### `retry.ts`

- Computes `requestHash` via `canonical.ts`, then calls `sessionContext.retrySeen(hash)` to get the current count for this session.
- Returns `number` (0 on first occurrence).

### `session.ts`

- `sessionId` resolution order:
  1. `metadata.user_id` if it is a string, ≤256 chars, printable-ASCII → use as-is.
  2. Otherwise `hmacSha256(localSalt, canonicalInput).toHex().slice(0, 32)`.
- `localSalt` is generated ONCE per proxy process (`crypto.randomBytes(32)`), held in a module-level `let`, NOT persisted anywhere, discarded on exit.
- `canonicalInput` = sorted-key JSON of:
  ```
  {
    systemPrefix: first 4096 chars of joined system,
    firstUserPrefix: first 4096 chars of first user message,
    toolNames: sorted tool names
  }
  ```
- Explicitly **excludes** timestamps, request IDs, file paths.

### `canonical.ts`

- Builds the canonical hash input for `requestHash`:
  - Fields: `{ systemPrefix, userMessagesPrefix: last 3 user messages truncated to 2048 chars each, toolNames: sorted, betaFlags: sorted }`.
  - Serialize with sorted keys, no whitespace (deterministic JSON).
  - `sha256(canonical).toHex().slice(0, 32)` → 128-bit hex.
- Explicitly **excludes** `model`, request IDs, timestamps, `metadata.user_id`.
- Used by classifier cache, outcome-tagger retry detection, decision log cross-reference, and `retry.ts` above.

### `beta.ts`

- Reads the `anthropic-beta` request header.
- Splits on `,`, trims each entry, drops empties, sorts, freezes.
- Returns `readonly string[]` (empty array when header absent).

### Other fields (inline in `extract.ts`)

- `messageCount` — `parsedBody.messages?.length ?? 0`.
- `estInputTokens` — delegates to `tokens.ts`.
- `explicitModel` — `typeof parsedBody.model === 'string' ? parsedBody.model : null`.
- `projectPath` — inferred from any file path present in recent tool_use `input` fields. Take the longest common prefix of absolute paths observed across the last ~10 tool_use blocks. `null` if none.
- `sessionDurationMs` — `Date.now() - sessionContext.createdAt`.

## Tests (TDD — write first, in `tests/signals/`)

Every test uses fixture JSON under `tests/fixtures/signals/` (create as needed). Keep fixtures minimal — only the fields each test exercises. Tests drive extractor behavior; implementation follows.

### Required test cases (one `it()` per bullet)

From the plan's §7.1 TDD list:

- plan-mode marker detected in `system` string
- plan-mode marker detected when `system` is a `ContentBlock[]`
- `messages[].content` of mixed blocks flattened correctly for text extraction
- token estimate produced by `js-tiktoken` cl100k encoder (not required to be exact; assert non-zero and roughly proportional to length)
- tool list extracted from `tools` array (sorted, deduped)
- file/path count detects `read_file`, `write`, `edit` tool-use patterns in history
- retry count increments when the same `requestHash` repeats within a session (drive via a fake `sessionContext.retrySeen`)
- frustration markers detected in the most recent user message (trigger phrases listed above) — case-insensitive, word-boundary
- explicit `model` in request captured as a signal
- project path inferred from any file path present in recent tool calls (longest common prefix)
- session duration computed from `createdAt`
- beta headers array populated from `anthropic-beta` comma-split (trimmed, sorted)
- **any extractor that throws degrades to `null`/`0`/`[]` for that signal — never fails the request** (drive by injecting a malformed fixture that makes one specific extractor throw; assert `extractSignals` still returns a frozen `Signals` and logs a warning)

From §7.2 (canonical hashing + sessionId):

- `requestHash` excludes `model` (changing only `model` yields identical hash)
- `requestHash` excludes request IDs, timestamps, `metadata.user_id`
- `requestHash` is stable across key-order permutations of the same body
- `sessionId` = `metadata.user_id` when present, string, ≤256 chars, printable-ASCII
- `sessionId` falls back to HMAC of canonical input when `metadata.user_id` is absent or invalid shape
- `localSalt` stays constant within a process (two extracts produce same HMAC sessionId for same canonical input) but is NOT persisted (not re-derivable from any public input)

## Implementation Rules (from global coding-style)

- TypeScript strict; no `any` on public surfaces. Use `unknown` + narrowing at extractor boundaries.
- Files under 150 lines preferred, 400 max. Functions under 50 lines.
- Immutability: `readonly` everywhere on the `Signals` surface. Freeze arrays before handing off.
- No console.log — use the pino logger passed in.
- Each file is one concern. `extract.ts` is an orchestrator; it owns the try/catch-per-extractor pattern, not the individual extractors.
- Extractors themselves throw freely on malformed input — the orchestrator is the only place that catches.

## Non-Goals

- No rule evaluation (section-08).
- No classifier calls (sections 11/12).
- No decision logging (section-13).
- No wiring into the proxy hot path (section-04 already parses the body and will call `extractSignals` once the policy section lands).
- `retryCount` only exposes the "how many times have we seen this hash" value — the session store that tracks hash counts lives in section-09. This section defines the `sessionContext.retrySeen` callback contract and tests against a fake.
