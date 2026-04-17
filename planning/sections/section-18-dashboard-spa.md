# section-18-dashboard-spa

## Scope

Build the **Vite + React + Recharts** single-page application that visualizes the ccmux decision log via the dashboard HTTP server (section-17). The SPA lives at `src/dashboard/frontend/` and is served statically by the dashboard server on `127.0.0.1:<port>` (default 8788).

**The hard guarantee for this section:** the built bundle is **fully self-contained**. No CDN scripts, no remote fonts, no remote source maps, no analytics, no telemetry. CI asserts zero outbound URLs in the built output, with the sole exception of `localhost` / `127.0.0.1` references.

## Dependencies

- **section-17-dashboard-server** — provides `/api/summary`, `/api/decisions`, `/api/costs`, and `/metrics`, and is the static-file host for the built SPA. This section consumes those endpoints; it does not modify server code.
- Assumes section-01 repo skeleton (`src/dashboard/frontend/` directory exists, TypeScript strict, Vitest wired).

## Background Context (self-contained)

The dashboard server (section-17) binds to `127.0.0.1` only, reads from the JSONL decision log (section-13), and exposes:

- `GET /api/summary` — aggregate counters (routing distribution, cost totals, cache-hit rate, latency percentiles).
- `GET /api/decisions?limit=N&since=ISO` — paginated decision rows. `limit` defaults to 100, max 1000 (server enforces clamp).
- `GET /api/costs` — cost breakdown with/without classifier overhead, grouped by model.
- `GET /metrics` — Prometheus text format (not consumed by the SPA).

Pricing table is served from config by the server, not embedded in the SPA — the SPA reads it from an endpoint or from `/api/summary`.

The user's browser opens to `http://127.0.0.1:<port>` via `ccmux dashboard`. The browser is the user's; ccmux itself makes no outbound calls. But the **bundle** must also make no outbound calls — no Google Fonts, no cdn.jsdelivr, no sourcemap URLs pointing off-box.

Coverage: `src/dashboard/frontend/` is **informational-only** (not counted against the 80% line-coverage floor). Tests still exist for the self-containment invariant and smoke rendering.

## Files to Create

### Build & tooling
- `src/dashboard/frontend/package.json` — local `package.json` pinned to the SPA's deps (React, Recharts, Vite, TypeScript). Kept separate from root `package.json` to isolate SPA build from Node runtime deps. Uses `npm` (per project standard).
- `src/dashboard/frontend/vite.config.ts` — Vite config. **Critical settings:**
  - `base: './'` (relative asset URLs so the server can serve from any path).
  - `build.sourcemap: 'inline'` or `false` — **never** remote source maps.
  - `build.assetsInlineLimit` high enough to inline small fonts/icons, OR bundle them as local files.
  - `build.rollupOptions.output` — single-file or standard chunked output, all local.
  - No `@vitejs/plugin-legacy` CDN polyfills.
  - Dev server proxy for `/api/*` → `http://127.0.0.1:8788` during local dev.
- `src/dashboard/frontend/tsconfig.json` — extends root strict config; JSX target `react-jsx`.
- `src/dashboard/frontend/index.html` — root HTML. **No `<link rel="stylesheet" href="https://…">`, no `<script src="https://…">`, no Google Fonts `<link>`.** Uses system font stack or a locally-bundled font file.

### App code
- `src/dashboard/frontend/src/main.tsx` — React root mount.
- `src/dashboard/frontend/src/App.tsx` — top-level layout; routes/tabs for Summary, Decisions, Costs.
- `src/dashboard/frontend/src/api/client.ts` — typed fetch wrappers for the three `/api/*` endpoints. All requests are same-origin relative (`/api/summary`, etc.) — never hard-code a host.
- `src/dashboard/frontend/src/api/types.ts` — TS types for `SummaryResponse`, `DecisionRow`, `CostBreakdown`. Mirror the server's response shapes (section-17 owns the schema).
- `src/dashboard/frontend/src/components/SummaryPanel.tsx` — counters, routing-distribution pie (Recharts `PieChart`), latency percentile bars.
- `src/dashboard/frontend/src/components/DecisionsTable.tsx` — paginated table. Client holds a `limit` (default 100) and a `since` filter. Honors server clamp silently.
- `src/dashboard/frontend/src/components/CostChart.tsx` — Recharts `BarChart` grouped by model, with/without-classifier-overhead toggle.
- `src/dashboard/frontend/src/styles.css` — all styles local. No `@import url(https://…)`.

### Assets
- `src/dashboard/frontend/public/` — any icons/fonts as local files. Empty acceptable if using system fonts.

### Server integration (reference only — owned by section-17)
- Section-17 serves `src/dashboard/frontend/dist/` as static files. This section is responsible for producing `dist/`, not wiring it into the server.

## Tests (write FIRST)

Location: `tests/dashboard/spa/`. Tests run under Vitest. Use `jsdom` environment for component smoke tests; use Node env for the bundle-scanner.

### Self-containment (the load-bearing tests)

1. **`no-outbound-urls.test.ts`** — after `npm run build` in `src/dashboard/frontend/`, walk every file under `dist/` (HTML, JS, CSS, map files, manifest). Regex for `https?://` URLs. Allowlist: `127.0.0.1`, `localhost`. Assert zero violations. This is the CI gate.
2. **`no-remote-sourcemaps.test.ts`** — parse built JS/CSS for `//# sourceMappingURL=…`. Assert every value is either a relative path, a `data:` URL, or absent. Fail on any `http(s)://`.
3. **`no-cdn-in-html.test.ts`** — parse `dist/index.html`. All `<link href>`, `<script src>`, `<img src>` must be relative or same-origin. No `fonts.googleapis.com`, no `cdn.*`, no `unpkg.com`.
4. **`no-remote-fonts.test.ts`** — scan built CSS for `@font-face { src: url(…) }` values. All must be relative or `data:`.

### Smoke rendering (jsdom)

5. **`app-renders.test.tsx`** — mounts `<App />` with `fetch` mocked to return fixture responses for the three `/api/*` endpoints. Asserts the summary panel renders without throwing.
6. **`recharts-offline.test.tsx`** — renders `<CostChart>` and `<SummaryPanel>` with no network available (jsdom has no network by default). Asserts Recharts SVG nodes are present. Guards against accidentally importing a Recharts plugin that fetches remote data.
7. **`decisions-pagination.test.tsx`** — client sends `limit=2000`, server (mocked) returns clamped 1000 rows. Asserts the UI displays 1000 rows and does not loop.
8. **`api-client-relative-urls.test.ts`** — every method on `api/client.ts` produces a URL whose `host` is empty (same-origin relative). Guards against a dev accidentally hard-coding `http://127.0.0.1:8788`.

### Server-side integration (reference; owned by section-17 but cross-checked here)

9. **`dashboard-binds-localhost.test.ts`** — already covered by section-17. Do not duplicate; this section assumes it passes.

## Implementation Notes

### Self-containment enforcement

The CI-gate test (`no-outbound-urls.test.ts`) is the contract. Before implementing features, write this test and make sure it passes against an empty Vite `dist/`. Then add app code incrementally, re-running the gate each time. Common ways a dev breaks self-containment:

- `index.html` pulls Google Fonts via `<link>`.
- A CSS file has `@import url('https://fonts…')`.
- Vite's `build.sourcemap: true` emits a sourceMappingURL pointing at a local file — that's fine; the regex should only reject `http(s)://` prefixes.
- A stray `console.log` in a lib trips a sourcemap URL check — scope the check to `sourceMappingURL` comments, not arbitrary console output.
- An NPM package lazily loads a worker from `unpkg`. Prefer deps that bundle everything statically; if Recharts pulls anything remote, pin a version that doesn't and document it in `package.json`.

### Fonts

Use a system font stack:
```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
```
If a custom font is required, ship the `.woff2` in `public/` and reference via relative `url()`.

### API client shape

```ts
export interface ApiClient {
  getSummary(): Promise<SummaryResponse>;
  getDecisions(params: { limit?: number; since?: string }): Promise<DecisionRow[]>;
  getCosts(params: { groupBy?: 'model' | 'session' }): Promise<CostBreakdown>;
}
```

All paths are `/api/…` — relative, same-origin. The browser's origin is `http://127.0.0.1:<port>`; never hard-code it in code.

### Pagination behavior

Client requests `limit=100` by default. If user requests more (e.g., infinite scroll), cap the client-side request at 1000 to avoid a round-trip that gets silently clamped — or display a "server clamped to 1000" notice when `response.length === 1000 && requested > 1000`.

### Build script wiring

Root `package.json` gains a script (coordinated with section-21 release-ci):
```json
"build:dashboard": "cd src/dashboard/frontend && npm ci && npm run build"
```
This produces `src/dashboard/frontend/dist/`, which section-17's server serves statically. The release pipeline (section-21) runs this before packaging.

### What NOT to build

- No WebSocket / live-tail of decisions — polling `/api/decisions?since=` is sufficient and simpler.
- No authentication UI — the dashboard is `127.0.0.1`-bound; section-17 handles any token gate.
- No user preferences persistence — no localStorage sync, no cookie. YAGNI.
- No dark-mode toggle unless trivially free with the chosen CSS approach.
- No client-side routing library — a tab switcher via React state is enough for three views.
- No i18n, no a11y audit infrastructure beyond basic semantic HTML.

## Definition of Done

- `npm run build` in `src/dashboard/frontend/` produces a `dist/` directory.
- All tests in `tests/dashboard/spa/` pass, especially the four self-containment tests.
- Mounting `<App />` against the real dashboard server (section-17 running locally) shows summary, decisions, and costs views populated from a real decision log.
- Lint passes (no files >400 lines; components small and focused).
- Zero `http(s)://` references to anything other than `127.0.0.1` / `localhost` in `dist/`.
