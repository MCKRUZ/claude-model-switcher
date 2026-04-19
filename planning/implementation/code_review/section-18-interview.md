# Section 18 Code Review Interview

## Auto-fixed
- **I-1**: Narrowed self-containment URL allowlist from blanket domain match to specific known React namespace URIs and dev doc patterns, with explanatory comments
- **I-2**: Added clamping test case — mock returns 1000 items for a large request, verifies UI renders <= 1000 rows
- **I-3**: Added error state to CostChart and DecisionsTable — now show error messages instead of silently showing empty UI
- **N-5**: Converted `limit` from useState to module-level const (LIMIT) since it's never user-configurable

## Let go
- **I-4**: Recharts mock in test — dual-React-instance in jsdom makes real Recharts impossible; self-containment tests on the actual bundle are the real CI gate
- **N-1**: Duplicate walkDir — not worth extracting for 3 files
- **N-2**: Root devDeps — needed for vitest test resolution, valid tradeoff
- **N-3**: Array index as key — harmless for stable pie chart data
- **N-4**: API signature diverges from plan — will update section plan in doc update step
