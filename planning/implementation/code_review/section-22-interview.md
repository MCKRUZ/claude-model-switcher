# Section 22 Code Review Interview

## Finding 1 — `ccmux dashboard` command documented but not implemented
**Decision:** Auto-fix. Remove `ccmux dashboard` from cli.md, quickstart.md step 5, and README.md step 4. The dashboard server module exists (src/dashboard/) but no CLI command launches it. Docs should reflect reality.

## Finding 2 — YAML fence validation missing rule-dsl.md
**Decision:** Auto-fix. Add `rule-dsl.md` to the YAML-checked files list in docs-check.ts.

## Finding 3 — classifier.model default
**Decision:** Let go. Verified: source defaults.ts line 11 confirms `claude-haiku-4-5-20251001`.

## Finding 4 — CLI entry-point detection on Windows
**Decision:** Let go. Works in practice via npm scripts; not worth complicating.
