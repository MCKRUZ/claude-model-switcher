# Section 18 Code Review

## IMPORTANT

### I-1: Self-containment allowlist includes outbound domains (fb.me, reactjs.org, www.w3.org)
`tests/dashboard/spa/no-outbound-urls.test.ts:6` — The `ALLOWED_PATTERN` permits `fb.me`, `reactjs.org`, and `www.w3.org`. These are URLs React embeds in error messages and license comments. The section plan says the CI gate should assert "zero outbound URLs" with only `127.0.0.1` / `localhost` allowed. The current allowlist means the built bundle *will* contain reachable external URLs, weakening the invariant. Functionally harmless (they're in string literals, not fetched at runtime), but the plan's contract is stricter.

**Fix options (pick one):**
- Accept the deviation and document it in the section plan as a known exception for React internals.
- Tighten the pattern back to `127.0.0.1|localhost` only and use a production React build (`NODE_ENV=production`) which strips most of these URLs. If any remain, add a narrow per-URL allowlist with a comment explaining each exception, rather than blanket domain matching.

### I-2: Pagination clamping test does not match the plan's scenario
`tests/dashboard/spa/decisions-pagination.test.tsx` — The plan specifies: "client sends `limit=2000`, server (mocked) returns clamped 1000 rows. Asserts the UI displays 1000 rows and does not loop." The actual test renders 100 rows with `limit=100` and asserts `rows.length === 100`. It never tests the clamping path (`limit > MAX_LIMIT`), nor does it verify the component handles server-side clamping gracefully (e.g., displaying a notice when `response.items.length < requested`).

**Fix:** Add a test case that mocks `getDecisions` returning 1000 items when 2000 were requested, and verify the UI renders exactly 1000 rows without infinite re-fetching. The `DecisionsTable` component already clamps client-side via `Math.min(limit, MAX_LIMIT)`, but that path is untested.

### I-3: Errors silently swallowed in CostChart and DecisionsTable
`src/dashboard/frontend/src/components/CostChart.tsx:32` — `.catch(() => setBuckets([]))` discards the error entirely. Same in `DecisionsTable.tsx:23` — `.catch(() => setRows([]))`. The user sees an empty chart/table with no indication that a fetch failed. `App.tsx` has an error state pattern (`setError(e.message)`) but these two components don't replicate it.

**Fix:** Add `error` state to both components and render an error indicator, consistent with what `App.tsx` already does for `getSummary`.

### I-4: `recharts-offline.test.tsx` mocks Recharts, defeating its own purpose
`tests/dashboard/spa/recharts-offline.test.tsx:32-47` — The plan says: "renders `<CostChart>` and `<SummaryPanel>` with no network available. Asserts Recharts SVG nodes are present. Guards against accidentally importing a Recharts plugin that fetches remote data." The test mocks all Recharts components with `<div>` stubs, so it cannot detect SVG rendering or catch a Recharts plugin that fetches remote data. It only tests that the wrapper components don't crash when given fixture data, which is already covered by `app-renders.test.tsx`.

**Fix:** Remove the `vi.mock('recharts')` block and render with real Recharts. Assert `container.querySelector('svg')` is present. jsdom has no network by default, so any remote fetch would throw — that's the point of this test.

## NICE-TO-HAVE

### N-1: Duplicate `walkDir` across three test files
`no-outbound-urls.test.ts`, `no-remote-fonts.test.ts`, `no-remote-sourcemaps.test.ts` each copy-paste the same recursive directory walker. Extract to a shared `tests/dashboard/spa/_helpers.ts`.

### N-2: React + React-DOM as root devDependencies is unnecessary weight
`package.json` adds `react`, `react-dom`, `recharts`, `jsdom`, and their `@types/*` to root devDependencies. These are only needed for `tests/dashboard/spa/` and the frontend build. The `vitest.config.ts` aliases already resolve to `node_modules/` — if these were only in `src/dashboard/frontend/package.json` and the aliases pointed there, the root `npm install` wouldn't pull the entire React dependency tree for non-dashboard developers.

### N-3: `SummaryPanel.tsx` uses array index as `key` in Pie Cell mapping
`src/dashboard/frontend/src/components/SummaryPanel.tsx:65` — `key={i}` on the `<Cell>` elements. The `pieData` array is derived from `Object.entries()` which has a stable order for a given object, and the array is not reordered, so this is harmless. But `key={entry.name}` (the model name) would be semantically clearer and satisfy the React lint rule.

### N-4: `getCosts` API signature diverges from section plan
The plan specifies `getCosts(params: { groupBy?: 'model' | 'session' })` but the implementation uses `{ bucket?: 'hour' | 'day' }`. This matches the actual section-17 server API, so it's correct — but the section plan should be updated to reflect reality.

### N-5: `DecisionsTable` has unused `limit` setter
`src/dashboard/frontend/src/components/DecisionsTable.tsx:10` — `const [limit] = useState(DEFAULT_LIMIT)` destructures without the setter. This is fine as-is (YAGNI), but if pagination size is never user-configurable, `limit` could be a plain `const` instead of state.

## VERDICT

**Warning** — no CRITICAL issues, four IMPORTANT issues (I-1 through I-4). I-1 weakens the core self-containment CI gate. I-2 and I-4 mean two of the eight tests don't actually verify what the plan requires. I-3 is a UX gap. None block merging, but I-1 and I-2 should be addressed before the section is marked as done.

Code quality is solid: all files under 150 lines, clean component decomposition, immutable types with `readonly`, relative API paths throughout, system font stack, no console.log, no hardcoded hosts.
