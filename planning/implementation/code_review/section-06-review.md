# Section-06 Config Watcher — Code Review

Verdict: **Approve with minor suggestions.** No critical or high-severity issues. Spec §1–8 are met; tests cover the required behaviors.

## Critical
None.

## Important
None.

## Suggestions

### 1. Race: `whenReady` never resolves if `stop()` is called before chokidar emits `ready`
File: `src/config/watcher.ts:79-82, 93-95`
The `whenReady` promise is only resolved via `watcher.once('ready', …)`. If a caller awaits `whenReady` but the watcher is closed before it fires (e.g., fast-fail startup path), the awaiter hangs forever. The `stop()` path does not settle `whenReady`. Low likelihood in production (shutdown currently doesn't await `whenReady`), but it's a footgun for tests and future callers.

Fix: resolve `whenReady` on close as well.
```ts
const whenReady = new Promise<void>((resolve) => {
  watcher.once('ready', () => resolve());
  // resolve() also from stop() path via a shared settled flag
});
```

### 2. `runReload` in-flight isolation vs. rapid successive reloads
File: `src/config/watcher.ts:55-71`
If a reload is mid-`await loadConfig(...)` and a new debounced `scheduleReload` fires, a second `runReload` runs concurrently. Both will `current = result.value.config`; the later completion wins regardless of which edit is newer. Not a torn-read issue (assignment is atomic), but the final `current` may not reflect the most recent file state if I/O completion order inverts. Spec §5 only requires readers never see a half-built config — which holds — so this is a suggestion, not a bug.

Fix (optional): serialize with a single-flight guard (`let reloading: Promise<void> | null`) so the next reload waits for the in-flight one and then re-reads.

### 3. Timer fire-after-stop is prevented, but `stopped` guard is belt-and-suspenders only
File: `src/config/watcher.ts:41-47, 55`
`stop()` clears `debounceTimer` and closes chokidar. The `if (stopped) return` at the top of `scheduleReload` and `runReload` correctly defends against the window between `await watcher.close()` draining events and the handler running. Good. No change needed — flagging because it was called out in scope.

### 4. `closeWatcher` swallows errors silently
File: `src/cli/start.ts:45-51`
Best-effort teardown during shutdown is reasonable, but blind `catch {}` loses diagnostics when the watcher misbehaves. Log at debug level so CI/dev can see failures without failing shutdown.
```ts
} catch (err) {
  // shutdown is best-effort, but keep a trace
  // logger.debug({ err }, 'watcher close failed');
}
```
Since `logger` isn't in scope here, either pass it in or leave as-is — minor.

## Nitpicks

### 5. Test `SETTLE_MS=3000` × 6 tests ≈ 18s wall time
File: `tests/config/watcher.test.ts:14, 116`
With polling (`interval: 50`) + debounce (100ms) + `awaitWriteFinish` (50/25ms), real settle should be ~200–300ms. 3000ms is defensive for parallel CI load. Acceptable, but if the suite becomes slow, tune down with an event-driven barrier (`onReload` promise) instead of `waitMs`.

Fix: replace the `waitMs(SETTLE_MS)` pattern in the debounce/swap tests with a resolved-on-`onReload` promise + a shorter timeout. Eliminates the primary flakiness vector.

### 6. Missing-file test may be flaky on very slow runners
File: `tests/config/watcher.test.ts:129-141`
`SETTLE_MS * 2` = 6s for an `add` event on a polling watcher at 50ms interval is generous, but chokidar's polling on Windows for a path that didn't exist at start can take multiple poll cycles to latch. If this goes flaky, the fix is the same — use an `onReload` promise barrier.

### 7. `configStore` is optional in `ProxyServerOptions`
File: `src/proxy/server.ts:16`
`readonly configStore?: ConfigStore;` — consistent with the noted fact that handlers don't consume it yet. Fine for now; make it required when section implementing policy routing lands so callers can't forget to wire it.

### 8. File size / style
`src/config/watcher.ts` is 96 lines — well under the 150-line budget. Naming is clear. One class/closure per file. No emojis, no console.log, no hardcoded secrets. Error handling uses structured pino logs per rules/security.md.
