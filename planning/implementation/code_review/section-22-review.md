# Section 22 Code Review

## Finding 1 — Important
**File:** docs/cli.md, docs/quickstart.md, README.md
**Issue:** `ccmux dashboard` command is documented but not registered in `src/cli/main.ts`. The CLI has no `dashboard` subcommand. References in quickstart step 5, README quickstart block, and the full cli.md entry all describe a non-existent command.
**Recommendation:** Either remove dashboard references from docs or add the CLI command. Since adding features is out of scope for a docs section, remove the references and note that the dashboard server starts automatically with the proxy.

## Finding 2 — Minor
**File:** scripts/docs-check.ts:98
**Issue:** YAML fence validation only runs on `config-reference.md` and `recipes.md`, but `rule-dsl.md` also contains YAML fences with example rules. A broken YAML example there would not be caught.
**Recommendation:** Add `rule-dsl.md` to the YAML-checked files list.

## Finding 3 — Minor
**File:** docs/config-reference.md:68
**Issue:** `classifier.model` default is `claude-haiku-4-5-20251001` — verify this matches the actual default in the config schema/loader source code.

## Finding 4 — Nit
**File:** scripts/docs-check.ts:117
**Issue:** CLI entry-point detection uses `process.argv[1] === fileURLToPath(import.meta.url)` which may not match on Windows when paths differ in casing or separator style. Works in practice for npm scripts but is fragile.
