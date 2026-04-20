# section-10-wrapper — code review

## CRITICAL

**1. Port/healthz race — the proxy has already been listening before `waitForHealthz` runs.** `startWrapperProxy` calls `listenWithFallback`, which only returns after Fastify's `listen()` resolves. By then `/healthz` is already serving. The polling loop in `waitForHealthz` is therefore cosmetic: the spec step 3 explicitly calls for waiting on `/healthz` before spawn, which only has meaning if the wait can detect a proxy that is listening but not ready. Either drop the poll entirely and document that Fastify `listen()` resolution is our readiness signal, or give the proxy a deferred-ready state worth polling.

**2. `teardownProxy` in the outer `finally` runs before the child has exited on the signal path.** On SIGINT/SIGTERM the settle fires when the child emits `exit`, which is correct. However, if `awaitChildExit`'s promise rejects (it can't today, it only resolves), we'd leak. Add a comment or make `awaitChildExit` explicitly never reject.

**3. Proxy token is passed into `createProxyServer` but `requireProxyToken` is never set.** `src/lifecycle/wrapper.ts` passes `proxyToken: token` but not `requireProxyToken: true`. Per `src/proxy/server.ts`, the token gate is a no-op without `requireProxyToken === true`. The in-code comment says this is intentional (Claude Code can't forward the header), matching the spec's §6.8 'defense-in-depth' framing — but then passing `proxyToken` at all is dead plumbing. Either (a) don't pass it, (b) set `requireProxyToken: true` and fail closed (contradicts spec), or (c) add a config flag that lets power users opt in. Leaving it in this half-wired state invites a future reader to 'fix' it by flipping the flag and breaking everyone.

## IMPORTANT

**4. `buildChildEnv` mutates the spread result — not strictly immutable per project rules.** Functionally equivalent to an object-literal overlay, but the coding-style rules say 'spread operators, never mutate objects/arrays.' Rewrite as `const env: NodeJS.ProcessEnv = { ...parentEnv, ANTHROPIC_BASE_URL: baseUrl, NO_PROXY: noProxy, no_proxy: noProxy, NOPROXY: noProxy, CCMUX_PROXY_TOKEN: token };` and drop the mutations.

**5. Token-redaction test is toothless.** `tests/lifecycle/wrapper.test.ts` bails out silently with `if (!existsSync(logPath)) return; // trivially passes`. If the log file isn't written in this test configuration, the assertion never runs. Worse, the wrapper code never logs the token in the first place — there's no path under test that would have logged it. To make this meaningful: either force a code path that logs the token or assert that `pino`'s redact config lists `CCMUX_PROXY_TOKEN`. Current test would pass even if token handling were completely broken.

**6. Signal-forwarding tests don't exercise `process` — they use an injected `EventEmitter`.** This is a pragmatic choice but it means the `installSignalForwarding` wiring with `process` as the default source is never integration-tested. Add one test that verifies `installSignalHandlers: true` with a default source adds listeners to `process`.

**7. Port-fallback test is flaky by design.** It relies on `nextPort()` which is `18800 + random(500)`. If a parallel test happens to grab the same port first, assertions invert. Seed from the test worker id or use discovery.

**8. ENOENT test exit code.** EACCES and friends collapse to 1 silently. Spec only calls out ENOENT so technically to-spec; `err.code` is logged, so OK. NIT.

**9. CLI handler swallows `runWrapper` rejections as exit 1 and writes the raw error message.** `src/cli/run.ts`. Any loaded-config field could land on stderr. Acceptable for now; SUGGESTION.

**10. Windows exit-code mapping correctness.** `exitCodeFor` is to-spec, but Windows signal forwarding is untested. Add a unit test calling `exitCodeFor(null, 'SIGTERM')` under both platform branches.

## SUGGESTION

**11. `ActionBox.childArgv` is stashed on a mutable box and read inside the subcommand action.** Works, but will not scale if another subcommand also wants post-`--` argv.

**12. `splitOnDoubleDash` returns arrays marked `readonly` but calls `argv.slice()`.** TypeScript types enforce readonly at the boundary; runtime is mutable. NIT.

**13. Fixture keep-alive** uses `setInterval(() => {}, 3600_000)`. Simpler: `await new Promise(() => {})`. NIT.

**14. Missing integration test for `main.ts` wiring.** Add one test invoking `run(['run', '--', 'claude', '--help'])` to confirm `--help` reaches the child, not commander.

**15. Spec acceptance criterion: `grep` assertion for token absence in logs.** Also check decision log directory / stderr captures if they exist.
