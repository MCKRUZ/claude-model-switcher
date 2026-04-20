# section-10-wrapper — review interview

## User decisions

**CRITICAL #3 — proxy token plumbing:** drop `proxyToken` from the `createProxyServer` call in `src/lifecycle/wrapper.ts`. Token stays only in the child env (defense-in-depth). Proxy is 127.0.0.1-only, no dead plumbing.

## Auto-fixes (no user input needed)

- **CRITICAL #1**: keep the healthz poll but add a comment explaining why (covers async-init edge cases; Fastify's `listen()` resolution is the primary readiness signal).
- **CRITICAL #2**: add a comment in `awaitChildExit` stating the invariant that it never rejects, to make the outer `finally` semantics safe.
- **IMPORTANT #4**: rewrite `buildChildEnv` as a single object-literal overlay — drop mutations.
- **IMPORTANT #5**: remove the silent `existsSync` bail-out in the token-redaction test. If the log file doesn't exist, fail loudly. Also assert the token doesn't appear in captured stderr (process.stderr write capture during wrapper run).
- **IMPORTANT #6**: add a test that verifies `installSignalHandlers: true` (default) attaches listeners to `process`.
- **IMPORTANT #7**: port-fallback test — make port selection deterministic using a unique port per run (incrementing counter) to avoid flakiness in parallel runs.
- **IMPORTANT #10**: add a unit test exercising `exitCodeFor` branches on both platforms (by exporting the helper or testing observable behavior via the wrapper).
- **SUGGESTION #14**: add an integration test for `run(['run', '--', 'node', ...])` through `main.ts` to confirm post-`--` argv reaches the child.

## Let go

- **IMPORTANT #8, #9**: nits per user conventions (leads are direct; not worth the churn).
- **SUGGESTION #11, #12, #13, #15**: nits / style / future-work — no action.
