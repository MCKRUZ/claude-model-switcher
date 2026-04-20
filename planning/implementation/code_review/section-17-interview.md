# Section 17 Code Review Interview

## Auto-fixed
- **I-3**: Validate `since` parameter — return 400 for unparseable dates
- **I-4**: Validate `group_by` — return 400 for unknown values
- **I-6**: Changed counter types to gauge (correct for sliding-window values)
- **N-5**: Fixed afterAll → afterEach in pricing test cleanup
- **I-2**: Added 100k record cap to summary/costs/metrics with `truncated` flag (user approved)

## Let go
- **I-1**: Loopback guard is defense-in-depth; caller uses listenWithFallback which binds 127.0.0.1
- **I-5**: Module-level cache is standard for single-process servers
- **N-1**: Duplicated test config — not worth extracting for 4 files
- **N-2**: readdirSync is fine for decision log dirs (few files)
- **N-3**: Sort perf — 30 records in fixture, not a bottleneck
- **N-4**: Invalid since test — covered implicitly by the 400 validation fix
