# Section-05 Code Review

## Summary
Section-05 largely matches the spec: listenWithFallback avoids the TOCTOU helper server, reject-h2 is cleanly extracted, and the three CLI subcommands are wired via commander with lazy imports. Tests cover the headline behaviors. A handful of real correctness issues should be fixed before commit - most notably a missing 5s hard-timeout force-exit and a test assertion that silently permits the TOCTOU bug it is supposed to check for.

## Critical Issues

### 1. Hard-timeout path drops the spec contract (no force-exit)
File: src/cli/start.ts:70-75
Spec line 115 requires: 5s hard timeout should call process.exit(1) with a log line. Current code does setTimeout(() => resolve(1), GRACE_MS). If server.close() hangs on an upstream socket, resolve(1) settles the Promise but Nodes event loop still has the open HTTP server keeping the process alive. The daemon sits forever instead of exiting. The timer must force-exit with process.exit(1) inside the setTimeout callback.

Also: hardTimer.unref() contradicts intent. If the timer is unrefd and the event loop goes idle, Node exits before the hard-timeout ever fires - so the force-exit branch can never log. Remove .unref() once the handler force-exits.

### 2. TOCTOU test assertion is off-by-one and hides the bug it exists to catch
File: tests/proxy/ports.test.ts:65-74
createServerSpy snapshots calls.length AFTER Fastify({ logger: false }) constructs the server. Fastifys own createServer call is therefore already in the baseline, not in the delta. The comment is wrong. Any listenWithFallback-internal helper server would produce delta == 1 and the test still passes. Tighten to expect(delta).toBe(0). Without this change, the entire section 6.6 TOCTOU guardrail is untested.

### 3. SIGINT/SIGTERM handlers leak across repeated startProxy invocations
File: src/cli/start.ts:77-78
process.once installs handlers on the global process. On normal shutdown (server.close resolves), the peer signals handler is never removed. Repeated runStart calls in the same process accumulate multiple handlers, each closed over a different server reference. Fix: explicitly removeListener after graceful shutdown, or accept a signalTarget parameter so tests can drive an EventEmitter stub rather than the global process.

### 4. readPidFile returns null for corrupt content, reported as not running
File: src/cli/status.ts:31, 46-55
A crash mid-write, truncation, or non-numeric content all yield null, and runStatus prints not running with exit 1. Operator assumes nothing is running and starts a second daemon, both fighting for the port range. Differentiate: missing file means not running; unparseable means PID file corrupt at path, exit 1 WITHOUT unlinking (preserve evidence). Also: writePidFile is not atomic - writeFileSync can leave a partial file if interrupted. A write-then-rename pattern eliminates this.

## Important Suggestions

### 5. bindWithFallback back-compat alias is a YAGNI violation
File: src/lifecycle/ports.ts:49-56
Comment claims used elsewhere. Before this diff section-04 called bindWithFallback; this diff replaces that path. If grep confirms no non-test callers, delete it. Per global rules: Replace, dont deprecate and Three similar lines beat a premature abstraction.

### 6. Spec-mandated onRequest belt-and-suspenders guard is not present
File: src/proxy/reject-h2.ts:15
Spec line 72: defensively also check the request line if PRI method shows up. Today the guard only fires in clientError. If Nodes parser ever admits a request with method PRI, it bypasses the guard entirely. Add a fastify onRequest hook checking req.raw.method equals PRI and reply 505 with the same JSON body.

### 7. status returns 0 for a live-but-unresponsive daemon
File: src/cli/status.ts:38-40
Exit 0 means all good to shell scripts. A degraded daemon should be distinct. Recommend return 2 so operators can write: ccmux status or alert. Spec is silent on the code, so surface for user decision.

### 8. probeHealth cannot distinguish timeout from connection refused
File: src/cli/status.ts:66-79
Both ECONNREFUSED and 1s-timeout collapse to null. Pass a logger and structured-log the underlying error before returning null. Cheap observability win, matches the projects structured-JSON logging rule.

### 9. Sync fs calls inside an async startProxy
File: src/cli/start.ts:82-83
mkdirSync and writeFileSync block the event loop. One-shot at startup so impact is negligible, but the file is otherwise async. Swap to fs/promises for consistency.

### 10. PID file location may not match spec
File: src/cli/start.ts via paths.pidFile
Spec line 113 resolves PID file via paths.configDir(). Test helper (tests/cli/start.test.ts:42) puts it under state/ccmux.pid, implying resolvePaths returns a stateDir-based path. XDG convention puts pidfiles in XDG_RUNTIME_DIR, so there is a legitimate spec-vs-convention conflict to surface.

## Nitpicks

- src/cli/main.ts:17 - ActionBox mutable closure is a named type for a one-field mutation hack. Could simplify by letting each action throw and propagate via parseAsync.
- src/cli/version.ts - spec line 117 prefers JSON import attributes. Current readFileSync+JSON.parse is a pragmatic workaround and fine for now.
- bin/ccmux.js:3-5 - the double .then reads awkwardly; one chain suffices since m.run returns Promise<number>.
- src/proxy/reject-h2.ts:13 - add a one-line comment that Buffer.byteLength(BODY) recomputes if BODY changes, so Content-Length stays correct.
- tests/cli/main.test.ts:40 - asserts not.toBe(0) for unknown command; spec line 95 says exit code 1. Tighten to toBe(1).
- tests/cli/status.test.ts:64 - deadPid = 999999 can flake under PID recycling. Prefer forking a child, waiting for exit, reusing its PID.

## Test Coverage Assessment

Gaps vs spec:
- Spec line 82 requires: SIGINT to foreground handler triggers graceful shutdown; exit code 0; /healthz stops answering within 500ms. No such test exists. Given Critical #1 and #3, this is material - signal-handler bugs surface only when signals are actually driven.
- No test for the pid-alive-health-unresponsive branch in status.ts.
- No test for corrupt PID file content (Critical #4).
- No test for PID file mode 0o600 or dir mode 0o700. Spec lists both explicitly; a one-line fstat assertion would cover it on POSIX.

Over-mocked or weak:
- tests/proxy/ports.test.ts TOCTOU assertion (Critical #2).
- tests/cli/start.test.ts bypass-on-unset test only probes /healthz, which is not token-gated in section-04s model. Acceptable here; revisit for section-06.

Roughly 80% of the acceptance criteria have real coverage. Signal handling is the biggest hole.

## Overall Recommendation

ship-with-fixes. Critical #1 and #2 must land in this section: #1 violates the specs own 5s hard-timeout contract, #2 silently disables the TOCTOU guardrail test. #3 and #4 are real footguns worth fixing now but arguably deferrable with tickets. Nothing here is a security CRITICAL (no secret leakage, no injection surface), so merge is not blocked on security - only on correctness of the signal and TOCTOU items.
