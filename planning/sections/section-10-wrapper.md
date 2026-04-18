# section-10-wrapper

## Purpose

Implement `ccmux run -- <cmd>`: the wrapper command that owns the proxy lifecycle. It starts the proxy, waits for healthz, builds the child environment (base URL redirect, NO_PROXY, optional proxy token, preserved auth env), spawns the child process with inherited stdio, forwards SIGINT/SIGTERM, tears down the proxy on child exit, and propagates the child's exit code.

There is no long-running daemon in the happy path — the wrapper is the entire runtime for a typical `ccmux run -- claude ...` invocation.

## Dependencies

- **section-09-sticky-model** (blocker): policy/session plumbing must be in place for the proxy the wrapper starts to be fully functional.
- Runs in parallel with section-11, section-12, section-13.
- Consumers: section-21-release-ci uses `ccmux run` for smoke tests.

Assume the following are already implemented:

- `src/proxy/server.ts` — Fastify proxy exposing `/v1/messages` and `/healthz` (from section-04).
- `src/lifecycle/ports.ts` — sequential port bind with `EADDRINUSE` handling (from section-05).
- `src/logging/logger.ts` — pino with auth redaction (section-02).
- `src/config/load.ts` — YAML config loader (section-03).
- `src/cli/main.ts` — commander router (from section-05); this section adds the `run` subcommand registration.

## Files to Create

- `src/lifecycle/wrapper.ts` — the wrapper orchestrator (child env build, spawn, signal forwarding, teardown).
- `src/cli/run.ts` — the `ccmux run -- <cmd...>` commander handler; parses the `--` separator, delegates to `lifecycle/wrapper.ts`.
- `src/lifecycle/token.ts` — generates a 128-bit random `CCMUX_PROXY_TOKEN` (crypto.randomBytes(16).toString('hex')).
- `tests/lifecycle/wrapper.test.ts` — Vitest tests per the TDD list below.
- `tests/cli/run.test.ts` — CLI parser tests (argument splitting around `--`).

## Files to Modify

- `src/cli/main.ts` — register the `run` subcommand. Parse the post-`--` argv (commander's `passThroughOptions` + `allowUnknownOption`, or manually split `process.argv`).

## Background Context (self-contained)

### Wrapper flow (canonical)

1. Parse `config.yaml` (via existing loader). Non-fatal warnings on unknown keys.
2. Start the proxy on the chosen port (sequential bind: try `config.port || 8787`, then increment until a free port is found or `maxPortProbes` exhausted — behavior implemented in section-05 `ports.ts`, just consume it).
3. Wait for `GET http://127.0.0.1:<port>/healthz` to return 200. Poll every 50 ms, timeout at 5 s → abort with a clear error. Use undici or plain `fetch`.
4. Generate a 128-bit proxy token (always — cheap). Pass it to the proxy process via `proxy.setToken(token)` or config injection so the proxy's token-gate middleware (section-04's `src/proxy/token.ts`) accepts the matching header.
5. Build child env (see below).
6. Spawn child with `stdio: 'inherit'` via `child_process.spawn(cmd, args, { env, stdio: 'inherit', shell: false })`.
7. Wire signal forwarding:
   - Parent receives SIGINT/SIGTERM → call `child.kill(sig)`.
   - On `child.exit(code, signal)` → stop proxy (`server.close()`), flush pino (`logger.flush()`), `process.exit(code ?? (signal ? 128 + os.constants.signals[signal] : 0))`.
8. If child emits an `error` event before spawn (e.g., `ENOENT`) → teardown proxy, log error, exit with 127.

### Child env

Start from `{ ...process.env }` (preserve everything), then overlay:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (the port actually bound, not the requested one).
- `NO_PROXY=127.0.0.1,localhost` — also set lowercase `no_proxy` and uppercase `NOPROXY` for tooling variance across Unix/Windows.
- `CCMUX_PROXY_TOKEN=<token>` — passed so downstream tooling (if it ever honors it) can forward; *not* required for Claude Code itself (Claude Code does not expose an outbound-header knob). This is defense-in-depth per plan §6.8.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR` — explicitly preserved if present in the parent env (they survive the spread, but the test asserts on them — keep behavior explicit and commented).

### Signal semantics

- Do not wrap the child in a shell — `spawn(cmd, args, { shell: false })` so SIGINT/SIGTERM reach the process directly, not a shell wrapper that would eat them.
- On Windows, `child.kill('SIGINT')` has limited semantics; document the caveat but call `kill()` regardless — Node translates to taskkill internally for SIGTERM/SIGKILL.
- Do not `process.exit()` until the proxy has closed and pino has flushed; otherwise tests that inspect the decision log tail will be flaky.

### Exit-code propagation

- Child exited normally with code N → exit N.
- Child killed by signal S → exit `128 + signalNumber(S)` (POSIX convention), or just `1` on Windows where signal→code mapping is unreliable.
- Spawn failure (`ENOENT` etc.) → exit 127.

## Tests (TDD — write these first)

### `tests/lifecycle/wrapper.test.ts`

Use a tiny in-repo script (e.g., `tests/fixtures/bin/echo-env.mjs`) as the child so tests don't depend on `claude` being installed. The script prints the env vars the test asserts on and exits 0, or loops on SIGINT and exits with the appropriate code.

Required tests (stubs, fill in bodies):

```ts
describe('ccmux run wrapper', () => {
  it('sets ANTHROPIC_BASE_URL to the bound proxy port in child env', async () => {/* ... */});
  it('preserves ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from parent env', async () => {/* ... */});
  it('sets NO_PROXY / no_proxy / NOPROXY to include 127.0.0.1 and localhost', async () => {/* ... */});
  it('generates and injects CCMUX_PROXY_TOKEN into child env', async () => {/* ... */});
  it('forwards SIGINT to the child, tears down proxy, and exits with child code', async () => {/* ... */});
  it('forwards SIGTERM to the child, tears down proxy, and exits with child code', async () => {/* ... */});
  it('propagates non-zero child exit code to wrapper exit code', async () => {/* ... */});
  it('when configured port is busy, uses the next free port and injects it into child env', async () => {/* ... */});
  it('exits 127 when child command is not found (ENOENT)', async () => {/* ... */});
  it('never writes the proxy token to any log line (redaction check)', async () => {/* ... */});
  it('waits for /healthz before spawning the child', async () => {/* ... */});
});
```

### `tests/cli/run.test.ts`

```ts
describe('ccmux run argv parsing', () => {
  it('splits argv on the first -- and treats everything after as child argv', () => {/* ... */});
  it('rejects invocations with no command after --', () => {/* ... */});
  it('forwards flags that look like ccmux flags if they appear after --', () => {
    // e.g., `ccmux run -- claude --help` must pass --help to claude, not to ccmux
  });
});
```

## Implementation Notes / Stubs

### `src/lifecycle/token.ts`

```ts
import { randomBytes } from 'node:crypto';
export const generateProxyToken = (): string => randomBytes(16).toString('hex');
```

### `src/lifecycle/wrapper.ts` (signature only)

```ts
export interface WrapperOptions {
  readonly childCmd: string;
  readonly childArgs: readonly string[];
  readonly configPath?: string;
}

export interface WrapperResult {
  readonly exitCode: number;
}

export const runWrapper: (opts: WrapperOptions) => Promise<WrapperResult>;
```

Internal helpers (not exported): `buildChildEnv(parentEnv, port, token)`, `waitForHealthz(port, timeoutMs)`, `installSignalForwarding(child)`.

### `src/cli/run.ts`

Commander subcommand. Because commander consumes `--` specially, the cleanest path is to pre-split `process.argv` in `main.ts` before commander sees it: find the first `--`, pass everything before it to commander, stash the remainder on a module-scoped variable the `run` handler reads. Keep this split logic in one small pure function so it's unit-testable.

## Acceptance Criteria

- All tests above pass.
- `ccmux run -- node -e "console.log(process.env.ANTHROPIC_BASE_URL)"` prints `http://127.0.0.1:<port>`.
- Ctrl+C at the wrapper terminates the child and the proxy within 1 s on Unix.
- No proxy-token value appears in any log file produced during the test run (grep assertion).
- Wrapper exit code equals child exit code for normal exits.
- File size under 400 lines; individual functions under 50 lines (project lint rules).

## Out of Scope

- `ccmux start [--foreground]` — that's section-05. The wrapper shares helpers with it (`lifecycle/ports.ts`, `lifecycle/signals.ts`) but does not reimplement them.
- Installing `claude` itself. The wrapper assumes the user has a working `claude` binary on PATH.
- Windows-specific signal translation beyond best-effort `child.kill()`. Document the caveat in `docs/troubleshooting.md` (section-22), not here.

## Implementation Notes (as-built)

Landed files exactly as planned:
- `src/lifecycle/wrapper.ts` — orchestrator with exported `runWrapper`, `buildChildEnv`, and `exitCodeFor` (exported to make the platform-specific mapping unit-testable).
- `src/lifecycle/token.ts` — 128-bit hex token generator.
- `src/cli/run.ts` — `runRun` handler + `splitOnDoubleDash` helper.
- `src/cli/main.ts` — registers `run` subcommand; argv is pre-split on `--` before commander parses so flags after `--` reach the child.
- `tests/fixtures/bin/echo-env.mjs` — fixture that snapshots env to JSON and optionally loops on signal.
- `tests/lifecycle/wrapper.test.ts` — 16 tests covering child env, signal forwarding (POSIX-only), exit-code propagation, ENOENT, port fallback, healthz gate, token non-leakage, default `process` signal source, and `exitCodeFor` unit cases.
- `tests/cli/run.test.ts` — 6 tests covering `splitOnDoubleDash` semantics, `runRun` missing-command case, and a `main.ts` integration test proving post-`--` argv reaches the child.

### Deviations from plan

1. **Proxy token gating.** The section's "Wrapper flow" step 4 reads "Pass [the token] to the proxy process via `proxy.setToken(token)` or config injection so the proxy's token-gate middleware accepts the matching header." In practice, Claude Code has no outbound-header knob, so enforcing `requireProxyToken` on the proxy would fail every request. The token is generated and injected into the child env (defense-in-depth, plan §6.8), but the wrapper's proxy instance does **not** set `requireProxyToken`. The 127.0.0.1-only bind is the real containment boundary. Inline comment in `startWrapperProxy` explains this.
2. **`healthz` poll.** Fastify's `listen()` only resolves once the socket is accepting, so `/healthz` is already live by the time we poll. The poll is kept as a clear-error backstop for async-init edge cases; see comment above `waitForHealthz`.
3. **`exitCodeFor` exported.** Exported from `wrapper.ts` so tests can exercise the POSIX signal→code mapping without spawning a real child.

### Test count / coverage

- Added tests: 22 (16 wrapper + 6 CLI); 2 POSIX-only signal tests + 1 POSIX-only `exitCodeFor` test skip on Windows.
- Full suite: 270 passing, 4 skipped (all platform-gated).
