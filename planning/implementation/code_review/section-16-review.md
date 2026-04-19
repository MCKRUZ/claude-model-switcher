# Section 16 -- ccmux tune Code Review

**Reviewer:** code-reviewer agent
**Date:** 2026-04-19
**Verdict:** Approve with warnings

---

## Summary

Clean, well-structured implementation. The analyzer-suggest-diff pipeline is correctly decomposed, files are small (68-155 lines), functions are short, and the code reuses existing infrastructure (readDecisions, tierOf, nextTier, parseDuration, Result) rather than reinventing. Tests cover all six spec requirements plus meaningful edge cases. No critical issues found.

---

## Critical Issues

None.

---

## Warnings (should fix)

### [W1] setFlag mutates the out parameter

**File:** src/cli/tune.ts:169-179

setFlag() receives the Flags object and mutates it via out[key] = value. This violates the immutability-first coding standard. The Flags interface itself is mutable (no readonly on fields), which enables this. While contained within parseFlags and the mutation target is locally created, the pattern is inconsistent with the project spread-operator preference.

**Fix:** Use local variables and build the Flags object at the end of parseFlags.

**Severity:** Low. The mutation is scoped to a single function local variable.

---

### [W2] Outcome timestamp comparison uses string ordering

**File:** src/tune/analyze.ts:130

The outcome loader filters by comparing ISO timestamp strings lexicographically. This works correctly only when both strings use the same timezone format (UTC with Z suffix). If since or parsed.ts ever uses a timezone offset like +05:00 instead of Z, the comparison breaks silently. The decision reader (src/decisions/reader.ts:56) uses the same pattern, so this is a pre-existing convention -- but worth noting.

**Fix (future):** Parse to epoch ms and compare numerically. Not urgent since all timestamps in the codebase are generated as UTC ISO strings.

**Severity:** Low. Consistent with existing codebase convention, but fragile.

---

### [W3] findRuleIdLine regex does not handle quoted YAML id values

**File:** src/tune/diff.ts:58-62

If the config file uses quoted id values (e.g. id: "trivial-to-haiku" with single or double quotes), the regex will NOT match because quotes are not accounted for. The fixture uses bare unquoted ids, but a user could reasonably quote them in their config.yaml.

**Fix:** Add optional quote matching to the regex pattern so both bare and single/double-quoted id values are matched.

**Severity:** Medium. A user with quoted YAML id values would get no suggestions silently.

---

### [W4] renderDiff choice: replacement regex is too narrow for quoted values

**File:** src/tune/diff.ts:37-39

Same issue as W3 -- if the YAML uses quoted choice values (e.g. choice: "sonnet"), neither the findChoiceLine regex nor the replacement regex will match the quoted form.

**Fix:** Extend both regexes to handle optional quotes and preserve the quoting style in the replacement via a backreference.

**Severity:** Medium. Same silent-failure-on-quoted-values concern as W3.

---

### [W5] analyze.ts file is 155 lines, exceeding the 150-line budget

**File:** src/tune/analyze.ts -- 155 lines

The section plan specifies a 150-line budget per file. The loadOutcomes function (~40 lines) and its helpers (safeParse, isOutcomeTag) are a natural extraction point into a small src/tune/outcomes.ts reader module. This would also improve testability of outcome loading in isolation.

**Severity:** Low. Five lines over is cosmetic, but the extraction would improve cohesion.

---

## Suggestions (consider improving)

### [S1] tierOf called with empty Map is a hidden contract

**File:** src/tune/suggest.ts:35

Passing an empty map to tierOf means it falls back to substring matching (lower.includes(family)). This works for current Anthropic model ids but means tune can never suggest escalation for custom-named models. If intentional, a comment would help. If not, consider accepting the config modelTiers map. The try/catch around it is the right defensive measure.

---

### [S2] Deterministic tie-breaking in mostCommon is good

**File:** src/tune/suggest.ts:55-63

The tie-breaking key < best ensures deterministic output regardless of Map iteration order. Nice touch for reproducible diffs. No action needed.

---

### [S3] Missing test: multiple suggestions produce multiple hunks

The diff renderer is tested for single-suggestion and empty cases, but there is no test asserting that two weak rules produce two separate @@ hunks in the output. Worth adding for confidence in the hunk concatenation logic.

---

### [S4] Missing test: --since=7d default is applied

No test verifies that omitting --since defaults to 7 days. An explicit test would prevent regressions on the default value.

---

### [S5] upstream_latency_ms accumulation is never consumed

**File:** src/tune/analyze.ts:73-75

latencySum and latencyCount are accumulated in RuleStats but never read by suggest.ts. The rationale string includes avg_cost but not average latency. If YAGNI applies, this is dead code. If reserved for section-18 dashboard, a brief comment noting the intended consumer would help.

---

## Correctness Checklist

| Check | Pass |
|-------|------|
| Abstain records skipped | Yes -- isLivePolicyHit returns false when abstain === true |
| Shadow records skipped | Yes -- isLivePolicyHit returns false when mode === "shadow" |
| Outcomes joined by request_hash | Yes -- loaded into Map, looked up per decision |
| Missing outcomes counted as unknown | Yes -- tag fallback to "unknown" in absorbRecord |
| MIN_FIRES floor enforced | Yes -- stats.fires < MIN_FIRES check in suggestOne |
| WEAK_THRESHOLD checked | Yes -- bad / stats.fires < WEAK_THRESHOLD |
| Opus ceiling (no escalation beyond opus) | Yes -- nextTier("opus", 1) returns "opus" (clamped), compareTiers returns 0 |
| Unified diff format valid | Yes -- ---/+++ header, @@ hunk headers, -/+ lines, context with space prefix |
| Config file never modified | Yes -- readFileSync only, renderDiff returns string |
| Exit code 0 on success (even no suggestions) | Yes |
| Exit code 1 on IO failure | Yes -- missing log dir or unreadable config |
| Exit code 2 on invalid flags | Yes -- bad --since or unknown args |
| No console.log | Yes -- all output via injected stdout/stderr streams |
| No stack traces leaked | Yes -- all catch blocks emit user-facing messages only |
| No path traversal risk | Yes -- paths from resolvePaths() or explicit --log-dir/--config flags |

## Security Checklist

| Check | Pass |
|-------|------|
| No hardcoded secrets | Yes |
| No path traversal from user input | Yes -- CLI paths passed directly to statSync/readFileSync |
| No internal paths leaked in errors | Yes -- error messages include user-provided paths only |
| Input validation on flags | Yes -- unknown args rejected with exit 2 |
| No eval or dynamic code execution | Yes |
| JSON.parse wrapped in try/catch | Yes -- safeParse in analyze.ts |

## Code Quality Summary

| Metric | Value | Limit | Status |
|--------|-------|-------|--------|
| src/cli/tune.ts | 147 lines | 400 | OK |
| src/tune/analyze.ts | 155 lines | 150 | Slightly over |
| src/tune/suggest.ts | 68 lines | 150 | OK |
| src/tune/diff.ts | 74 lines | 150 | OK |
| Longest function | parseFlags ~22 lines | 50 | OK |
| Test count | 13 tests across 4 files | 6 required | OK |
| Functions > 50 lines | 0 | 0 | OK |
| console.log usage | 0 | 0 | OK |
| Deep nesting (>4 levels) | 0 | 0 | OK |

## Verdict

**Approve with warnings.** W3 and W4 (quoted YAML values) are the most actionable items -- they cause silent failure for a legitimate config style. The rest are low-severity consistency and hygiene items. No blockers.
