# Section-05 Code Review Interview

## Auto-fixes (applied without interview)

1. **Critical #1** — `src/cli/start.ts` hard-timeout: change `resolve(1)` to `process.exit(1)`; remove `hardTimer.unref()` so the force-exit branch can actually fire. Spec line 115 mandates `process.exit(1)`.
2. **Important #6** — `src/proxy/reject-h2.ts`: add Fastify `onRequest` hook that rejects requests with method `PRI` (belt-and-suspenders per spec line 72).
3. **Nitpick** — `tests/cli/main.test.ts:40`: tighten `not.toBe(0)` to `toBe(1)` per spec line 95.
4. **Important #5 rejected** — `bindWithFallback` is NOT YAGNI. `tests/proxy/health.test.ts` imports and uses it. Keep alias. Updated review conclusion.

## User-approved decisions

### Critical #3 — SIGINT handler leak
**Decision:** removeListener after graceful shutdown.
**Action:** Save handler references in `startProxy`; after `server.close()` resolves (not via signal), call `process.off('SIGINT', h)` and `process.off('SIGTERM', h)`.

### Critical #4 — Corrupt PID file
**Decision:** Distinguish "corrupt" from "missing". Corrupt → exit 1 with `PID file corrupt at <path>` (preserve evidence, no unlink). Missing → exit 1 with `not running`.
**Action:** In `src/cli/status.ts`, change `readPidFile` to throw a typed error on parse failure; `runStatus` handles ENOENT vs parse-error separately.

### Important #10 — PID file location
**Decision:** Keep `stateDir` (section-02 resolver). Spec line 113 says `configDir()` but tests and XDG convention prefer stateDir. Record deviation in updated section-05 doc.

### Test coverage additions
**Decision:** Add all three:
- SIGINT graceful shutdown test (spec line 82) — sub-process fork pattern.
- PID file perm-mode test (0o600 file, 0o700 dir) — POSIX only, skip on Windows.
- Corrupt PID file test — paired with Critical #4 fix.

## Let-go items

- Important #2 (TOCTOU test assertion `toBeLessThanOrEqual(1)`) — on reflection, Fastify's own `createServer` inside the spy window makes `<=1` the correct assertion. Reviewer's `toBe(0)` would fail. Keep as-is.
- Important #7 (status degraded exit code 2) — spec silent; exit 0 for "pid alive, /healthz down" is acceptable for now.
- Important #8 (probeHealth structured logging) — premature; no logger wired in status path yet.
- Important #9 (sync fs in async startProxy) — one-shot startup, negligible; swap when we have other reasons to touch the file.
- All nitpicks except main.test.ts assertion tightening.
