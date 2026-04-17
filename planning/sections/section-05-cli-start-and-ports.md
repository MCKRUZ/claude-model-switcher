# section-05-cli-start-and-ports

## Purpose

Wire the Phase 0 Fastify proxy (from section-04) to a real CLI entry point. Ship three commands — `ccmux start [--foreground]`, `ccmux status`, `ccmux version` — and the sequential port-binder used by every server in the codebase (proxy now, dashboard later). Enforce localhost-only binding and reject HTTP/2-prior-knowledge connections. `ccmux run` is a different section (section-10); this section only produces a debug foreground runner plus the shared lifecycle primitives.

## Dependencies

- **section-04-proxy-phase0** — provides `buildProxyServer(config): FastifyInstance` and the `/healthz` route. This section imports that factory and hands it a listen-address resolved by `lifecycle/ports.ts`.
- **section-03-config** — `loadConfig()` returns `{ port, mode, security, … }` with `port` defaulting to 8787.
- **section-02-logging-paths** — `logger`, `~/.config/ccmux` resolver, and PID-file directory.
- **section-01-repo-skeleton** — `commander` dependency is declared in `package.json`; `src/cli/` exists but empty.

## Files to Create

| Path | Responsibility |
|------|----------------|
| `src/cli/main.ts` | commander router; registers `start`, `status`, `version` subcommands. Exports `run(argv)` so tests can drive it without spawning a process. |
| `src/cli/start.ts` | `ccmux start [--foreground]` handler. Foreground = block on SIGINT; background = fork-detach + write PID file. |
| `src/cli/status.ts` | `ccmux status` handler. Reads PID file, probes `/healthz`, prints human table. |
| `src/cli/version.ts` | `ccmux version` handler. Prints `name@version` from `package.json` (read once at import time). |
| `src/lifecycle/ports.ts` | `listenWithFallback(server, host, startPort, maxAttempts)` — sequential bind, catch `EADDRINUSE`, try next. |
| `src/proxy/reject-h2.ts` | Fastify plugin / raw-HTTP preface check that rejects HTTP/2 prior-knowledge connections with 505. |
| `bin/ccmux.js` (or `bin/ccmux.cjs` per dual-export) | Thin shebang shim → `require('../dist/cli/main.js').run(process.argv.slice(2))`. |

## Files to Modify

- `src/proxy/server.ts` — register the `reject-h2` plugin at the very first `onRequest` hook, before anything else runs.
- `package.json` — add `"bin": { "ccmux": "bin/ccmux.js" }`.

## Behavior Spec (from claude-plan.md §6.6, §6.8, §11)

### `ccmux start [--foreground]`
1. Load config via `loadConfig()`.
2. Build proxy server via `buildProxyServer(config)` (section-04 export).
3. Call `listenWithFallback(server, '127.0.0.1', config.port, 20)` — returns actual bound port.
4. Print `ccmux listening on http://127.0.0.1:<port>` (stdout, not pino).
5. If `--foreground`: install SIGINT/SIGTERM handlers → graceful `server.close()` → exit 0.
6. If **not** `--foreground`: write `<pid>` to `~/.config/ccmux/ccmux.pid` and keep the event loop alive. (Full daemonization — `child_process.spawn` detach + `unref` + `stdio: 'ignore'` — is out of scope; the "foreground" flag is the primary path and what the tests drive.) Per plan §11, `ccmux start` is a "debug sibling" — a single long-lived process with a PID file is sufficient.
7. Do **not** spawn a child command. That's `ccmux run` (section-10).
8. **Debug mode means `CCMUX_PROXY_TOKEN` is unset** — the proxy's token gate is bypass-on-unset. Tests in §6.8 depend on this.

### `ccmux status`
- Reads `~/.config/ccmux/ccmux.pid`. If absent → print `not running`, exit 1.
- Sends `GET /healthz` to `http://127.0.0.1:<port-from-healthz-probe>` — but we don't know the port, so: (a) store the bound port next to the PID (`ccmux.pid` holds `pid\nport\n`), (b) probe `/healthz`, (c) print `{pid, port, uptimeMs, version, mode}`.
- If PID file exists but process is dead (signal 0 throws ESRCH) → print `stale PID file, removing` and unlink.

### `ccmux version`
- Prints `ccmux <version>` where version is read synchronously from `package.json` at module load.
- Exit 0.

### `lifecycle/ports.ts` — Sequential bind

```ts
export async function listenWithFallback(
  server: FastifyInstance,
  host: string,
  startPort: number,
  maxAttempts: number,
): Promise<number>;
```

Rules from plan §6.6 and §6.9:
- **Do not** `net.createServer().listen().close().listen(realServer)` — TOCTOU race.
- Call `server.listen({ host, port })` directly; on rejection, inspect `err.code === 'EADDRINUSE'`; increment port; retry up to `maxAttempts` (default 20).
- Any other error — rethrow.
- After `maxAttempts` — throw a clear error listing the range tried.
- Return the actually-bound port (read `server.server.address()`).

### `reject-h2.ts` — HTTP/2 prior-knowledge rejection

Fastify runs HTTP/1.1 only. A client that sends the HTTP/2 connection preface (`PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`) must be rejected with status 505 **HTTP Version Not Supported**. Implement as an `onRequest` hook that checks `request.raw.httpVersionMajor === 2` (already 1.1 at this layer, but defensively also check the request line if `PRI` method shows up) and replies 505 with a small JSON body. Kept as a separate file so the test can import and unit-test it.

## Tests (Vitest, under `tests/cli/` and `tests/proxy/`)

Extract from `claude-plan-tdd.md` §6.6 (ports/bind), §6.8 (proxy token interplay with `ccmux start`), and add CLI smoke tests.

### `tests/cli/start.test.ts`
- Test: `ccmux start --foreground` binds and `/healthz` returns 200.
- Test: server binds to `127.0.0.1`, never `0.0.0.0` — assert `server.server.address().address === '127.0.0.1'`.
- Test: `ccmux start` (no `CCMUX_PROXY_TOKEN` set) — requests without `x-ccmux-token` succeed (bypass-on-unset semantics).
- Test: SIGINT to foreground handler triggers graceful shutdown; exit code 0; `/healthz` stops answering within 500ms.
- Test: PID file is written on non-foreground start and removed on graceful shutdown.

### `tests/cli/status.test.ts`
- Test: no PID file → exit 1 with `not running` on stdout/stderr.
- Test: stale PID (process dead) → unlinks and reports stale.
- Test: live proxy → prints port, pid, uptimeMs, mode.

### `tests/cli/version.test.ts`
- Test: prints `ccmux <semver>` matching `package.json` version.
- Test: exits 0.

### `tests/cli/main.test.ts`
- Test: unknown subcommand → usage to stderr, exit code 1.
- Test: `--help` prints all three subcommands.

### `tests/proxy/ports.test.ts` (covers §6.6 port collision)
- Test: when `startPort` is free, `listenWithFallback` binds on it and returns it.
- Test: when `startPort` is in use (open a dummy `net.Server` in the test), `listenWithFallback` returns `startPort + 1`.
- Test: when ports `startPort` through `startPort + maxAttempts - 1` are all occupied, throws with a message naming the range. (Don't actually open 20 sockets; mock `server.listen` to reject 20× with `EADDRINUSE`.)
- Test: non-EADDRINUSE errors (e.g., `EACCES`) are rethrown immediately without retry.
- Test: no TOCTOU helper server is ever created (spy on `net.createServer` — call count = 0 within `listenWithFallback`).

### `tests/proxy/reject-h2.test.ts` (covers §6.6 HTTP/2 rejection, §6.9 HTTP/2 prior knowledge row)
- Test: a raw TCP client sending the HTTP/2 preface gets 505 and a JSON body naming HTTP/1.1.
- Test: an HTTP/1.1 GET `/healthz` is **not** rejected (negative control).

## Implementation Notes

- Use `commander` (already in `package.json` from section-01). Declare the three subcommands in `main.ts`; each subcommand imports its handler lazily (`await import('./start.js')`) so `ccmux version` stays fast.
- `bin/ccmux.js` must use `#!/usr/bin/env node` and forward to `dist/cli/main.js`. Keep the shim at ≤10 lines.
- PID file path: resolve via `paths.configDir()` (section-02). Format: two lines — `<pid>\n<port>\n`. Plain text; no JSON. Tests parse this.
- `ccmux status` probes `/healthz` with a 1s undici timeout. If the probe fails but PID is alive, report `pid alive, /healthz not responding` — don't lie about uptime.
- Graceful shutdown on SIGINT: `server.close()` then `process.exit(0)`. 5s hard timeout → `process.exit(1)` with a log line. This matches the signal-propagation contract set up in section-07 but is self-contained here.
- Printing: use `process.stdout.write` + `\n`, not `console.log` (per global coding-style — no `console.log`). Logger (pino) is fine for structured events, but user-facing one-liners go to stdout directly.
- Version source: `import pkg from '../../package.json' with { type: 'json' }`. Don't re-read at runtime.

## Out of Scope

- `ccmux run -- <cmd>` child spawning — section-10.
- Config hot-reload — section-06.
- SIGHUP/SIGUSR1 signals beyond SIGINT/SIGTERM graceful shutdown — section-07.
- Dashboard server bind (same `ports.ts` will be reused there, but wiring happens in section-17).

## Done Criteria

- `npm run build && node bin/ccmux.js version` prints the version.
- `node bin/ccmux.js start --foreground` binds on 8787 (or next free), logs the URL, responds 200 on `/healthz`, and exits cleanly on Ctrl+C.
- `node bin/ccmux.js status` in another terminal reports the running PID and port.
- All tests above pass.
- `src/lifecycle/ports.ts`, `src/proxy/reject-h2.ts`, and every `src/cli/*.ts` file are each under 150 lines.
