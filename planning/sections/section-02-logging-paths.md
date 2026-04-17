# section-02-logging-paths

## Purpose

Establishes two cross-cutting primitives used by every later section:

1. **XDG-style path resolver** — cross-platform resolution of ccmux's config, log, and state directories. Windows-safe via `path.join` at all boundaries; no shell calls at runtime.
2. **pino logger factory** — one shared structured JSON logger, configured with a hard-coded redaction list for auth headers, plus helpers for per-request child loggers.

Also ships the standalone **auth-header sanitizer** so non-pino code paths (errors thrown to stderr, CLI output, test assertions) can never accidentally leak `authorization`, `x-api-key`, or `x-ccmux-token` values.

## Dependencies

- **section-01-repo-skeleton** — directory layout (`src/config/paths.ts`, `src/logging/logger.ts`, `src/privacy/redact.ts`, `tests/`), TypeScript strict config, vitest config, lint rules. This section does not modify skeleton files.

## Files to Create

| Path | Responsibility |
|---|---|
| `src/config/paths.ts` | `getConfigDir()`, `getLogDir()`, `getStateDir()`, `getConfigFile()`, `getDecisionLogDir()`, `ensureDirs()` |
| `src/logging/logger.ts` | `createLogger(opts)`, `childLogger(base, bindings)`, exported default redaction paths list |
| `src/privacy/redact.ts` | `sanitizeHeaders(headers)`, `SANITIZABLE_HEADER_NAMES` (lowercased set). (The hashed/full/none content-redaction policy is deferred to section-13.) |
| `tests/logging/paths.test.ts` | Path resolver tests (see below) |
| `tests/logging/logger.test.ts` | Logger redaction tests |
| `tests/logging/redact.test.ts` | Header sanitizer tests |

No other files are modified.

## Design

### Paths — `src/config/paths.ts`

Behavior:

- Base config dir:
  - `$CCMUX_HOME` if set (testing + power-users override, highest priority).
  - Else `$XDG_CONFIG_HOME/ccmux` if `XDG_CONFIG_HOME` is set.
  - Else `~/.config/ccmux` on Linux/macOS.
  - Else `%APPDATA%\ccmux` on Windows (`process.env.APPDATA`); if `APPDATA` is somehow unset (CI containers), fall back to `path.join(os.homedir(), '.config', 'ccmux')`.
- Log dir: `<configDir>/logs/` (decision logs live in `<configDir>/logs/decisions/`, reserved for section-13).
- State dir: `<configDir>/state/` (PID file, classifier cache, etc.).
- Config file: `<configDir>/config.yaml`.
- All joins go through `node:path.join` / `path.resolve`. No string concatenation of path separators anywhere.
- `ensureDirs()` creates the config, log, state, and decision-log dirs with `fs.mkdirSync(..., { recursive: true, mode: 0o700 })`. Idempotent. Returns `void`. Throws only on non-`EEXIST` errors.

Exported API (stubs):

```ts
export interface CcmuxPaths {
  readonly configDir: string;
  readonly configFile: string;
  readonly logDir: string;
  readonly decisionLogDir: string;
  readonly stateDir: string;
  readonly pidFile: string;
}

export function resolvePaths(env?: NodeJS.ProcessEnv): CcmuxPaths;
export function ensureDirs(paths: CcmuxPaths): void;
```

`env` parameter exists purely for test injection; production call sites pass no argument and get `process.env`.

### Logger — `src/logging/logger.ts`

Behavior:

- Thin wrapper over `pino` with fixed redaction config. Redaction paths (exact, non-wildcarded where possible):
  - `req.headers.authorization`
  - `req.headers["x-api-key"]`
  - `req.headers["x-ccmux-token"]`
  - `headers.authorization`
  - `headers["x-api-key"]`
  - `headers["x-ccmux-token"]`
  - `err.config.headers.authorization` (undici error shape)
- Level from `CCMUX_LOG_LEVEL` (default `info`; `debug` when `CCMUX_DEBUG=1`).
- Destination:
  - If `opts.destination === 'stderr'` (default for CLI): `pino.destination(2)`.
  - If `opts.destination === 'file'`: `pino.destination({ dest: path.join(paths.logDir, 'ccmux.log'), sync: false, mkdir: false })`. Caller must have run `ensureDirs()` first.
- `childLogger(logger, bindings)` returns `logger.child(bindings)` — used by hot path to attach `request_hash`, `session_id_hash`, `request-id`.
- Never auto-rotates the operational log — decision-log rotation is a separate concern handled in section-13. The operational `ccmux.log` is expected to be small (startup, errors, warnings) and the user can manage it manually or via logrotate.

Exported API (stubs):

```ts
export interface LoggerOptions {
  readonly destination: 'stderr' | 'file';
  readonly logDir?: string;       // required when destination === 'file'
  readonly level?: pino.Level;
}

export function createLogger(opts: LoggerOptions): pino.Logger;
export const REDACT_PATHS: readonly string[];
```

### Header sanitizer — `src/privacy/redact.ts`

- Pure function. Takes a `Record<string, string | string[]>` (or `Headers`) and returns a shallow copy where any header whose lowercased name is in `SANITIZABLE_HEADER_NAMES` is replaced with the literal string `"[REDACTED]"`.
- Handles duplicate headers (array values) by replacing the entire array with `["[REDACTED]"]`.
- Case-insensitive match but preserves original case in output keys.
- Zero dependencies. Used by error-path logging, the synthetic SSE error message builder (section-04), and test assertions.

Exported API (stubs):

```ts
export const SANITIZABLE_HEADER_NAMES: ReadonlySet<string>; // lowercased
export function sanitizeHeaders<H extends Record<string, string | string[] | undefined>>(headers: H): H;
```

## Tests (TDD — write first, RED → GREEN)

Tests live in `tests/logging/`. Use vitest, no mocks for `fs` — use temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(), 'ccmux-'))` and clean up in `afterEach`.

### `tests/logging/paths.test.ts`

- `resolvePaths` honors `CCMUX_HOME` over everything else.
- `resolvePaths` honors `XDG_CONFIG_HOME` when `CCMUX_HOME` is unset.
- On Linux/macOS with no env hints, falls back to `~/.config/ccmux`.
- On Windows, uses `%APPDATA%\ccmux` when `process.platform === 'win32'`. (Simulate by passing an env snapshot with `APPDATA` set; the implementation must branch on the platform, so this test runs conditionally on `process.platform === 'win32'` OR by factoring the platform as an injectable parameter — pick one and be consistent.)
- `configFile` is always `configDir + '/config.yaml'`.
- `decisionLogDir` is always `logDir + '/decisions'`.
- `pidFile` is always `stateDir + '/ccmux.pid'`.
- `ensureDirs` creates all four directories when none exist.
- `ensureDirs` is idempotent — calling twice does not throw.
- `ensureDirs` propagates non-`EEXIST` errors (simulate by pointing at a path whose parent is a file, not a dir).

### `tests/logging/logger.test.ts`

- A log record with a `req.headers.authorization` field emits `[Redacted]` in that position.
- A log record with `req.headers["x-api-key"]` field emits `[Redacted]`.
- A log record with `req.headers["x-ccmux-token"]` emits `[Redacted]`.
- Non-sensitive fields (`req.method`, `req.url`, `msg`) pass through unmodified.
- `createLogger({ destination: 'stderr' })` writes to fd 2 (assert by stubbing `process.stderr.write` or piping via a `Writable` injected via pino's `stream` option in a test-only overload — prefer spying on the destination stream).
- `createLogger({ destination: 'file', logDir })` writes to `<logDir>/ccmux.log` (assert the file exists and contains the message after `logger.flush()` or after a `setImmediate` tick).
- `childLogger(base, { request_hash: 'abc' })` emits `request_hash: 'abc'` in every subsequent record.
- Level respects `CCMUX_LOG_LEVEL=debug` (env var read at factory time, not at every call).
- Matches the tests carried over from plan §6.7: "pino log emitted for each failure mode includes `request-id` when available, never raw auth headers" — cover by asserting a constructed log record with `authorization: 'Bearer sk-ant-xxx'` never contains `sk-ant-xxx` anywhere in the serialized JSON. (Covered downstream in section-04 end-to-end; here we verify only the redaction primitive.)
- Matches plan §6.8 "the token never appears in any log line (sanitized)" — `x-ccmux-token` redaction test above satisfies this unit-level.

### `tests/logging/redact.test.ts`

- `sanitizeHeaders({ authorization: 'Bearer x', 'x-api-key': 'k', foo: 'bar' })` returns `{ authorization: '[REDACTED]', 'x-api-key': '[REDACTED]', foo: 'bar' }`.
- Header name matching is case-insensitive: `Authorization`, `AUTHORIZATION`, `authorization` all redacted.
- Output keys preserve original casing.
- Array values (duplicate headers) are replaced with `['[REDACTED]']`.
- `undefined` values remain `undefined` (do not fabricate `[REDACTED]` for absent headers).
- `sanitizeHeaders` does not mutate its input (deep check: pass an object, compare original afterwards).
- `SANITIZABLE_HEADER_NAMES` is exactly the lowercased set `{'authorization', 'x-api-key', 'x-ccmux-token'}`.

## Acceptance Checklist

- [ ] `src/config/paths.ts`, `src/logging/logger.ts`, `src/privacy/redact.ts` created.
- [ ] All tests in `tests/logging/` pass under `npm test`.
- [ ] No file over 150 lines; no function over 50 lines.
- [ ] `pino` and `@types/pino` added to `package.json` dependencies (pino as runtime, types if not bundled).
- [ ] No runtime `console.log` / `console.error` calls anywhere under `src/`.
- [ ] Redaction verified end-to-end: a quick smoke test where a fake Bearer token is logged and the serialized output is grep'd for the token — must not be found.
- [ ] Windows path behavior manually smoke-tested (or gated in CI on `windows-latest`) — `resolvePaths` returns backslash-joined paths under `APPDATA`.

## Non-Goals (Deferred)

- Decision-log JSONL writer, rotation by byte counter, retention sweep → **section-13**.
- `logging.content: hashed | full | none` policy application to message bodies → **section-13** (this section only handles header-level redaction).
- Config schema + loader (`src/config/load.ts`, `schema.ts`, `defaults.ts`) → **section-03**.
- Config file watcher → **section-06**.
- PID file write/read semantics → **section-05** (this section only computes the path).
