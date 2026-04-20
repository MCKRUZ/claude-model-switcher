# Section-20 Code Review: ccmux explain

**Verdict: Approve with suggestions**

## IMPORTANT (2)

1. **Missing "does not write to decision log" test**: Plan specifies this test but it was replaced with classifier-not-requested test. Explain doesn't import the log writer so it structurally can't write, but spec called for spy-based proof.

2. **`renderSignalTable` omits `sessionId` and `requestHash`**: 12 of 14 signal fields rendered. These two are omitted — useful for correlating with decision logs but non-deterministic for diffing.

## SUGGESTION (3)

1. **`stubSession().retrySeen` always returns 0**: Correct for dry-run but could confuse users debugging retry rules. Consider a comment.
2. **`Date.now()` in `stubSession`**: Introduces non-determinism in `sessionDurationMs`. Tests handle via normalization.
3. **`renderChoice` unreachable fallback**: Returns `'unknown'` — branch unreachable but could use exhaustive check.

## NITPICK (2)

1. **`import.meta.dirname ?? ''` fallback**: Would silently produce wrong path if undefined.
2. **Inconsistent padding in final output**: `Final decision:` alignment differs from `Request:`/`Config:`.

## Positives

- Clean rendering function separation
- Correct `allowDowngrade` bridging from CcmuxRule to loadRules
- Silent pino logger for dry-run
- Solid test coverage across all exit code paths
- File sizes within limits (explain.ts: 169 lines)
