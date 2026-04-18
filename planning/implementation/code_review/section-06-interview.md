# Section-06 Code Review Interview

## Triage

Reviewer approved the implementation with no Critical or High-severity findings. Spec §1–8 verified met. Two Suggestions and a couple of Nitpicks.

No user interview was required — both suggestions were low-risk defensive improvements with obvious correctness wins. Auto-applied.

## Auto-Fixes Applied

### 1. `whenReady` never resolves on early stop() — RESOLVED
**Finding:** `whenReady` was wired only to `watcher.once('ready', resolve)`. If `stop()` is called before chokidar emits `ready`, any awaiter hangs forever.
**Fix:** Captured the resolver and also call it from `handle.stop()` so awaiters unblock in either path.
**File:** `src/config/watcher.ts:79-99`

### 2. Concurrent `runReload` could invert completion order — RESOLVED
**Finding:** If a new reload fires while one is in-flight (`await loadConfig` is async), the two could interleave such that an older reload's assignment to `current` lands *after* a newer one's — undoing the swap.
**Fix:** Single-flight guard with a `reloadPending` coalescing flag. First reload runs to completion; any events arriving during flight set `reloadPending`, which triggers one follow-up run in the `finally` block. Also added `if (stopped) return;` check after the `await` to prevent post-stop assignment.
**File:** `src/config/watcher.ts:36-80`

Verified: `npx vitest run tests/config/watcher.test.ts` → 6/6 pass.

## Nitpicks — Let Go

- **Tests use ~18s wall time (`SETTLE_MS=3000` × 6).** Acceptable trade-off for reliability on Windows polling. Converting to event-driven `onReload` promise barriers would tighten timing but adds test-harness complexity for no correctness gain.
- **`closeWatcher` swallows errors in start.ts.** Shutdown path is best-effort by design; adding a debug log would be noise.
- **`configStore?` is optional in `ProxyServerOptions`.** Correct for now — handlers are stubs. Will become required when policy routing lands (section-08+).
