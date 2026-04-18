# section-08-policy Interview Transcript

## User Decisions

### M1 — balanced.yaml threshold drift (messageCount < 5 vs spec's < 3)
**Decision:** Update spec to match recipe. Section doc update (step 9) will note the rationale (fixture-set intent is the canonical routing-ratio assertion).

### M3 — evalCondition composite guard
**Decision:** Add defensive throw in `evalCondition` — if a node has `all|any|not` AND any other key, throw. One-line safety for the in-memory path that section-09 will use.

## Auto-Fixes (low-risk, consistent with existing loader behavior)

### M4 — parseChoice rejects unknown keys inside `{ modelId }`
Every other composite/leaf in `load.ts` rejects unknown keys. Extend the same to the `modelId` branch so `{ choice: { modelId: "x", tier: "opus" } }` errors instead of silently dropping `tier`.

## Let Go
- **M5** (parseFieldCond cascade comment): intentional behavior, flagged only for awareness. No code change.
- **N1–N5**: cosmetic nitpicks; leaving as-is.
- **M2** (signals-schema spec drift): handled at step 9 (section doc update).
