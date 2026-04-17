# section-06-config-watcher

## Purpose

Add hot-reload behavior to the running ccmux proxy: a chokidar-based watcher observes `config.yaml`, debounces rapid filesystem events, revalidates the YAML, and atomically swaps the in-process config (rule set + pricing table + any other configured values). If the new file is invalid YAML or fails schema validation, the previous config stays active and the error is logged. In-flight requests are unaffected — each request captures a config snapshot at the start of handling; reloads only affect subsequent requests.

## Dependencies

- **section-03-config** — provides the YAML loader, schema, and Result-style validation errors (with JSON-pointer paths) used to parse/validate the reloaded file.
- **section-04-proxy-phase0** — provides the Fastify server lifecycle; the watcher is started alongside the proxy and torn down on shutdown.

Do not duplicate loader or validator code from section-03 — import and reuse it.

## Files to Create

- `src/config/watcher.ts` — `startConfigWatcher(...)` / `stopConfigWatcher(...)` plus a `ConfigStore` (or equivalent holder) exposing `getCurrent()` for the proxy request path. If section-03 already exports a config holder, extend it instead of creating a parallel one.
- `tests/config/watcher.test.ts` — Vitest suite covering debounce, atomic swap, invalid-YAML retention, and in-flight request isolation.

If section-03 already provides a config holder/store, place the watcher wiring in `src/config/watcher.ts` and keep the holder in its existing location.

## Dependency additions

- Runtime: `chokidar` (listed in plan §4 tech-stack table; add to `dependencies`).
- No new dev dependencies.

## Behavioral Requirements

1. **Watch target:** the resolved path of the active `config.yaml` (the same path section-03 loaded from). Follow symlinks off by default — watch the resolved path.
2. **Debounce:** 500ms trailing debounce on `change`/`add` events. Multiple rapid saves (editors that write-then-rename, IDE autosave bursts) collapse into a single reload attempt.
3. **Atomic swap:** read → parse → validate → on success, swap the in-memory reference in a single synchronous assignment. Readers (`getCurrent()`) always see either the old or the new config, never a half-constructed one.
4. **Invalid YAML / schema failure:** keep the previous config active. Emit a `warn`-level pino log with the validation error (including the JSON-pointer path from section-03). Do not throw, do not crash the proxy.
5. **In-flight isolation:** handlers must call `getCurrent()` exactly once at the start of request processing and use that snapshot for the duration of the request. The watcher module must not mutate any object that a handler is already holding a reference to — swap the whole config object by reference.
6. **Unknown top-level keys:** continue to warn (not crash) per section-03's forward-compat rule. That behavior is inherited from the loader, not reimplemented here.
7. **Teardown:** `stopConfigWatcher()` closes the chokidar instance and clears any pending debounce timer. Called during proxy shutdown so tests and `ccmux start --foreground` exit cleanly.
8. **Startup behavior:** the watcher does not itself perform the initial load — section-03's loader produces the initial config, the watcher only handles subsequent edits.

## Suggested API Shape

```ts
// src/config/watcher.ts
export interface ConfigStore {
  getCurrent(): AppConfig;
}

export interface WatcherHandle {
  stop(): Promise<void>;
}

export function startConfigWatcher(
  configPath: string,
  initial: AppConfig,
  logger: pino.Logger,
  opts?: { debounceMs?: number } // default 500
): { store: ConfigStore; handle: WatcherHandle };
```

`AppConfig` is the validated config type defined in section-03. Reuse it verbatim.

## Tests (write first)

Extracted from `claude-plan-tdd.md` §7.3 — the two hot-reload tests live under the policy-engine heading but are owned by this section:

- **Test: hot-reload (500ms debounce):** editing `config.yaml` swaps the rule set without restart. Write a valid config, start the watcher, overwrite the file with a new valid config, advance fake timers by 500ms, assert `store.getCurrent()` returns the new rule set.
- **Test: hot-reload with invalid YAML keeps the previous config active and logs a validation error.** Overwrite the file with malformed YAML (or a schema violation), advance timers, assert `store.getCurrent()` still returns the original config and that the logger recorded a `warn` with the pointer.

Additional tests owned by this section:

- **Debounce coalescing:** three rapid writes within 500ms produce exactly one reload attempt.
- **Atomic swap under read contention:** a handler that captures `getCurrent()` before the swap continues to see the old config even after the swap completes (simulate by holding the reference across an `await`).
- **Teardown:** after `handle.stop()`, further file edits do not trigger reloads and there are no dangling timers (Vitest fake-timer leak check).
- **Non-existent file at start:** constructing the watcher on a missing path does not throw; it logs and remains idle until the file appears. (Follows from chokidar's default behavior but assert it explicitly.)

Use `vi.useFakeTimers()` for the debounce tests. Use a real temp directory (`node:fs` + `os.tmpdir()`) for the filesystem side — do not mock chokidar; it is the thing under test.

## Implementation Notes

- Instantiate chokidar with `{ ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 } }`. `awaitWriteFinish` handles editors that write-then-rename; the 500ms debounce sits on top for additional safety.
- Keep the reload handler strictly async and wrapped in try/catch — any error path must log and leave the old config intact. Never let a rejected promise escape the chokidar event handler.
- The store is a tiny closure over a `let current: AppConfig` — do not introduce an EventEmitter or observer pattern; handlers poll `getCurrent()` at request start, which is sufficient and simpler.
- File size budget: `src/config/watcher.ts` should be well under 150 lines.

## Wiring

- `src/proxy/server.ts` (created in section-04) must be updated to call `startConfigWatcher` after the initial config load and to read per-request config via `store.getCurrent()` rather than capturing the initial config in closure. Make that change here so the hot-reload path is exercised end-to-end.
- `stopConfigWatcher` is invoked from the proxy's shutdown handler (same place that closes the Fastify instance).

## Out of Scope

- Reloading anything that requires rebinding the port (port override changes do not take effect until restart — log a warning if `ports.*` changes on reload).
- Signaling the wrapper or dashboard processes about config changes — they have their own configs / no config.
- Persisting reload history to the decision log (section-13 concern, not this one).
