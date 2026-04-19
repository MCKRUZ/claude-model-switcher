# section-22-docs: User Documentation

## Overview

This is the final section of the ccmux implementation. It produces the human-facing documentation: `README.md` at repo root and a `docs/` tree covering quickstart, configuration reference, rule DSL, recipe cookbook, privacy modes, and troubleshooting. No runtime code. CI from section-21 must already publish the binaries referenced in install instructions.

**Dependencies:** section-21 (all artifacts and CLI commands must exist and be final). This section consumes the shipped behavior of sections 01-20 as source-of-truth for what to document.

**Non-goals:** no marketing site, no generated API reference (TypeDoc), no screenshots of the SPA beyond one hero image, no blog. Docs live in the repo as plain Markdown.

## Deliverables

Create the following files (all paths relative to repo root):

- `README.md` — landing page: one-paragraph pitch, install, 60-second quickstart, link map into `docs/`.
- `LICENSE` — MIT (if not already created by section-01).
- `docs/quickstart.md`
- `docs/config-reference.md`
- `docs/rule-dsl.md`
- `docs/recipes.md`
- `docs/privacy.md`
- `docs/troubleshooting.md`
- `docs/cli.md` — one-page cheat sheet for `ccmux run`, `start`, `status`, `version`, `init`, `report`, `tune`, `explain`, `dashboard`.
- `docs/architecture.md` — short: proxy hot path, policy engine, classifier race, decision log, dashboard. One ASCII diagram.
- `docs/threat-model.md` — what ccmux does and does not protect against. Calls out the hashed-log linkability caveat verbatim.

## Content Requirements

### README.md

Must contain, in this order:

1. One-sentence description: "ccmux is a local, zero-telemetry routing proxy for Anthropic's API that picks the cheapest model that will still do the job."
2. Badges: CI status, npm version, Docker pulls, license.
3. Install block with all four artifact paths from section-21: `npx ccmux`, `npm i -g ccmux`, single-file binary download (`curl` one-liner per OS/arch), `docker run ghcr.io/<owner>/ccmux`.
4. 60-second quickstart: `ccmux init --recipe balanced && ccmux run -- claude`.
5. Prominent "What ccmux does NOT do" callout: no telemetry, no outbound calls except `api.anthropic.com`, no modification of message bodies, auth headers pass through unchanged.
6. Link map to each `docs/` page.

### docs/quickstart.md

Walk through the exact first-run experience: install, `ccmux init`, open `~/.config/ccmux/config.yaml`, `ccmux run -- claude`, observe the decision log at `~/.local/state/ccmux/decisions/YYYY-MM-DD.jsonl`, open `ccmux dashboard`.

### docs/config-reference.md

Table of every top-level key and sub-key in `config.yaml`. For each: type, default, example, which section of the codebase consumes it. Must cover at minimum: `mode`, `port`, `logging.content` (three modes), `logging.rotation`, `logging.retention_days`, `classifier.pin`, `classifier.haiku.timeout_ms`, `pricing` table, `rules`, `recipes`, `session.ttl_hours`, `session.hmac_salt`. Note that unknown top-level keys warn rather than crash (forward-compat).

### docs/rule-dsl.md

Document the `all`/`any`/`not` composition, first-match-wins, `abstain` fallthrough. Show three worked examples: plan-mode → opus, high-tool-count → sonnet, short question → haiku. Link to `docs/recipes.md` for batteries-included starting points. Include the full list of extractable signals from section-07 (plan-mode, message count, tool count, token estimate, file/path count, retry count, frustration markers, explicit model hint, project path, session duration, beta headers).

### docs/recipes.md

Document the three shipped recipes (`frugal`, `balanced`, `opus-forward`) shipped under `src/policy/recipes/`. For each: one-line philosophy, full YAML inlined, expected cost profile vs. always-opus baseline, when to pick it.

### docs/privacy.md

Document the three `logging.content` modes verbatim:

- `hashed` (default) — message strings and tool `input` fields replaced with `sha256(content).slice(0, 12)`. **Equality linkable** — include the threat-model note: "With `hashed`, two identical secrets become the same 12-char hash and are linkable across log entries. Use `none` on shared machines."
- `full` — everything logged. Auth headers still redacted by the sanitizer.
- `none` — messages and tool inputs dropped entirely; only signals and metadata remain.

Also state the zero-telemetry stance: ccmux makes no outbound calls other than to `api.anthropic.com`. No auto-update checks, no background telemetry, no fixture capture. The user's browser opened by `ccmux dashboard` is the user's, not ccmux's.

### docs/troubleshooting.md

Flat list of symptom → cause → fix. Minimum entries:

- `EADDRINUSE` on start → port taken, sequential-bind will try next; override with `--port`.
- "Claude CLI hangs" → `ANTHROPIC_BASE_URL` not set in child env; verify with `ccmux status`.
- "Costs show null" → upstream response missing `usage.*` fields; check classifier model / streaming.
- Config change not picked up → 500ms debounce; check logs for invalid YAML (previous config stays active).
- Dashboard shows no data → decision log path mismatch; confirm `~/.local/state/ccmux/decisions/` exists.
- HTTP/2 client error → ccmux rejects h2-prior-knowledge; use HTTP/1.1.

### docs/threat-model.md

One page. Scope: ccmux is a **local** proxy bound to `127.0.0.1`. It does not protect against a compromised local user account. Auth headers pass through unchanged — ccmux is not an auth broker. Log files are mode-0600 but readable by the same user. Include the hashed-log linkability caveat.

## Tests

Documentation is validated by lint/CI checks only. No unit tests. Add these CI assertions (wire into the section-21 CI workflow — this section only adds the check scripts under `scripts/docs-check.ts`):

- **Markdown link checker:** every relative link in `README.md` and `docs/**/*.md` resolves to an existing file.
- **Code-fence lint:** every fenced YAML block in `docs/config-reference.md` and `docs/recipes.md` parses with the same loader as `src/config/load.ts` (import and reuse the loader; do not reimplement).
- **Forbidden-string check:** `README.md` and `docs/privacy.md` must contain the literal strings `zero-telemetry` and `api.anthropic.com`. Fail CI if either is missing — protects the stated privacy posture from silent doc drift.
- **No placeholder text:** grep fails the build if any doc file contains `TODO`, `TBD`, `FIXME`, or `<placeholder>`.

Stub signature for the check script:

```ts
// scripts/docs-check.ts
export async function checkDocs(): Promise<{ ok: boolean; errors: string[] }>;
```

CLI entry: `npx tsx scripts/docs-check.ts` exits 0 on success, 1 with a human-readable error list on failure.

## Acceptance Criteria

- All files listed under **Deliverables** exist and are non-empty.
- `scripts/docs-check.ts` passes locally and in CI.
- `README.md` renders correctly on GitHub (no broken Mermaid, no unclosed fences).
- Every CLI command mentioned in docs matches the actual `--help` output from the shipped binary (manual spot-check; not automated).
- Privacy posture (`zero-telemetry`, auth-passthrough, `api.anthropic.com`-only outbound) is stated within the first screenful of `README.md` and is the subject of the top-level section of `docs/privacy.md`.
- No doc file exceeds 400 lines. Split into sub-pages if needed.

## Out of Scope

- Generated TypeDoc API reference.
- Internationalization. English only for v1.
- Screenshots beyond one hero image in `README.md`.
- A docs site generator (MkDocs, Docusaurus). Plain Markdown in-repo only.

## Implementation Notes (Post-Implementation)

### Files Created/Modified
- `README.md` — rewritten with pitch, badges, install, quickstart, "What ccmux does NOT do", doc link table
- `scripts/docs-check.ts` — CI-runnable validator: link checker, YAML fence lint, required-string check, placeholder check
- `tests/release/docs-check.test.ts` — integration test for docs-check
- `docs/quickstart.md` — 5-step walkthrough (install, init, run, report, tune)
- `docs/cli.md` — 8 CLI commands + dashboard module note
- `docs/config-reference.md` — all config keys with YAML examples
- `docs/rule-dsl.md` — all/any/not composition, 14 signals, 3 worked examples
- `docs/recipes.md` — frugal, balanced, opus-forward with YAML and cost profiles
- `docs/privacy.md` — three logging modes, zero-telemetry stance, hashed-log linkability
- `docs/troubleshooting.md` — 8 symptom/cause/fix entries
- `docs/architecture.md` — ASCII flow diagram, components, design decisions
- `docs/threat-model.md` — scope, protections, non-protections, linkability caveat

### Deviations from Plan
1. **`ccmux dashboard` CLI command removed from docs** — the dashboard server module exists (`src/dashboard/`) but no CLI command is registered. Code review caught this; docs updated to reflect reality.
2. **Decision log path** — docs use `~/.config/ccmux/logs/decisions/` (actual path) instead of `~/.local/state/ccmux/decisions/` (plan path).
3. **Config key names** — adapted to match actual implementation: `stickyModel.sessionTtlMs` instead of `session.ttl_hours`, `classifier.model` instead of `classifier.pin`, `logging.rotation.maxFiles/maxSizeMb` instead of `logging.retention_days`.
4. **YAML fence validation scope** — added `rule-dsl.md` to the checked files (code review fix), not just config-reference.md and recipes.md.
5. **No LICENSE file** — already existed from section-01.

### Test Summary
- 1 integration test in `tests/release/docs-check.test.ts` — validates all docs pass link, YAML, required-string, and placeholder checks
- Full suite: 517 tests pass (1 pre-existing flaky watcher test intermittent)
