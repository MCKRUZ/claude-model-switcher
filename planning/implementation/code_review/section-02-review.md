# Section-02 Code Review — Logging, Paths, Redaction

**Verdict: APPROVE with minor suggestions.** No CRITICAL or HIGH issues. All spec items implemented, all acceptance-checklist items met, redaction is effective against documented attack surfaces.

## Spec Conformance

All three source files exist with the required exported API. All 28 tests pass. Files are well under 150 lines (paths 59, logger 66, redact 32). No `console.*` calls. Precedence order in `resolveConfigDir` matches spec exactly: `CCMUX_HOME` → `XDG_CONFIG_HOME` → Windows `APPDATA` → `~/.config/ccmux` fallback. Empty-string env values are correctly treated as unset via `.length > 0`. `ensureDirs` uses `mkdirSync(..., { recursive: true, mode: 0o700 })`, is idempotent, and propagates non-EEXIST errors (verified by the "parent-is-file" test). The header sanitizer is pure, case-insensitive, preserves original casing, handles arrays, and leaves `undefined` intact.

## CRITICAL
None.

## HIGH
None.

## MEDIUM

**[MEDIUM] Redaction path coverage gap — header casing.**
`src/logging/logger.ts:6-14` — pino's `redact.paths` matches property names literally, not case-insensitively. If upstream code ever logs `req.headers.Authorization` (capital A, e.g., forwarded via Node `http.IncomingMessage` which lowercases, but undici/`fetch` `Headers` objects or manually-constructed payloads may not), the bearer token will leak. The spec says "exact, non-wildcarded where possible," but consider adding the canonical capitalized variants or documenting that callers must pre-lowercase via `sanitizeHeaders` before logging. Low likelihood in practice since both Node http and undici normalize to lowercase, but worth a defensive note or a `req.headers["Authorization"]` entry.

**[MEDIUM] Whole-object logging bypass.**
If a caller does `log.info({ request: req })` (not `{ req }`) or `log.info(req)` at the top level, none of the REDACT_PATHS match and headers leak. Mitigation: section-04 hot-path code must be audited to only use `{ req: ... }` bindings, or add a `pino` `serializers.req` that runs `sanitizeHeaders`. Not a defect in this section — just a tripwire for downstream sections.

## LOW

**[LOW] Censor string mismatch.**
Logger uses `'[Redacted]'` (mixed case); sanitizer uses `'[REDACTED]'` (upper). Trivial, but grep-based smoke tests and operators will get inconsistent results. Pick one.

**[LOW] `mode: 0o700` on Windows is a no-op.**
`mkdirSync` silently ignores POSIX mode bits on Windows — directories inherit parent ACLs. Not fixable without `icacls`, but worth a one-line code comment so future readers don't assume the config dir is locked down on Windows.

**[LOW] Whitespace-only env values accepted.**
`env.CCMUX_HOME = '   '` passes the `.length > 0` guard and becomes the config dir. Unlikely in practice but cheap to fix with `.trim().length > 0`.

## NIT

- `logger.test.ts` `captureLogger` duplicates the redact config inline rather than going through `createLogger` with an injected stream — acceptable, but a `stream` option on `LoggerOptions` would let the real factory be exercised.
- `REDACT_PATHS` is typed `readonly string[]` but spread into a mutable array at use site (`[...REDACT_PATHS]`). Fine, just noting the copy is load-bearing for pino's internal mutation.

## Security Assessment

Redaction is effective for the three documented paths (`req.headers.*`, `headers.*`, `err.config.headers.authorization`). Verified by test: `'Bearer sk-ant-xxx'` never appears in serialized output. No hardcoded secrets. No injection surface. Path resolver does not shell out. `ensureDirs` does not follow symlinks unsafely (mkdirSync recursive is safe).

**Approve for merge.**
