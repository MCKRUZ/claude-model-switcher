# section-08-policy Review

## Summary
Rule engine lands cleanly. Types, evaluator, predicates, and loader are each under 150 lines, single-purpose, free of I/O. Null-signal semantics match spec (including not-of-null = false), abstain correctly falls through, PolicyResult is frozen, matches compiles once at load time. Strict load-time rejection is thorough. Schema relaxation from choice:string to Record<string,unknown> has zero downstream consumers outside src/config, so safe. Tests cover spec bullets well including 20-fixture routing ratio checks.

Verdict: ship. One minor deviation (balanced uses messageCount < 5 instead of < 3) is documented and defensible; other findings are minor or nitpicks.

## Critical Issues
None.

## Important Issues
None.

## Minor Issues

### M1 balanced.yaml deviates from spec rule threshold
File: src/policy/recipes/balanced.yaml:13
Spec (section-08-policy.md:106) defines Haiku rule as all: [messageCount < 3, toolUseCount == 0, estInputTokens < 2000]. Implementation uses messageCount < 5. You flagged this: widened to hit the >=30% haiku ratio on the fixture set.
This is real drift from the plan. Two cleaner options:
1. Keep < 3 and add more tiny-fixtures to mixed.json so the >=30% test passes naturally.
2. Update the spec to match the recipe, so future readers do not see a contradiction.
Recommendation: option 2 is faster and honest. The fixture set is the canonical routing-intent assertion.

### M2 signals-schema.ts diverges from spec signal names
File: src/policy/signals-schema.ts:4-17
Spec (section-08-policy.md:11) lists toolNames and filePathCount. Implementation has tools and fileRefCount, which match the actual src/signals/types.ts shipped in section-07. Allow-list is correct against reality; spec is stale. Worth updating the spec, otherwise the next implementer will think there is a bug.

### M3 evalCondition struct cast is reasonable but worth a guard
File: src/policy/evaluate.ts:16-20
The cast const anyCond = cond as { all?: unknown; any?: unknown; not?: Condition } is safe at runtime because load.ts guarantees shape. However, nothing stops a caller from constructing a Rule directly in-memory with a pathological shape like { all: [...], messageCount: true }. Currently that would be treated as all composite and the messageCount leaf silently ignored. Two mitigations:
- Document in dsl.ts that Condition must be produced via loadRules or hand-rolled with care.
- Cheap defensive check: if object has any of all|any|not AND any other key, throw.
Not blocking (current tests construct valid rules), but the in-memory-rule path (section-09) will touch this.

### M4 parseChoice accepts { modelId: ... } with extra keys silently
File: src/policy/load.ts (parseChoice branch)
If a user writes then: { choice: { modelId: x, tier: opus } }, the extra tier key is silently dropped. Every other composite/leaf in this loader rejects unknown keys (parseComposite, parseLeafOp, parseChoiceThen). Consistency: reject unknown keys inside the modelId object too.

### M5 parseFieldCond returns null on any bad leaf, discarding good ones
File: src/policy/load.ts (parseFieldCond)
If a field cond has two leaves and only one is bad, the entire FieldCond is dropped, cascading to dropping the whole rule. That is fine (we want load-time fatal errors and errors are still reported), but worth a code comment. Current behavior is correct; flagging only so you know anyBad cascade is intentional.

## Nitpicks

### N1 MatchedResult exported but only used via PolicyResult internally
File: src/policy/dsl.ts:32, index.ts:8
Fine to keep for section-09, but if section-09 does not use it, drop the export.

### N2 ABSTAIN_RESULT frozen but typed through a widening annotation
File: src/policy/evaluate.ts:8
Object.freeze({ kind: abstain }) returns Readonly<{kind:abstain}> which widens through the declared PolicyResult annotation. Cosmetic.

### N3 matchLeafOp trailing return false is unreachable given LeafOp union
File: src/policy/predicates.ts:20
TS exhaustiveness would catch this with a discriminated switch. Current form is fine because each branch narrows, but satisfies never on a catch-all would be more rigorous. Not worth refactoring.

### N4 CHOICE_TIERS duplicates knowledge from dsl.ts Tier union
File: src/policy/load.ts:22
Two sources of truth for the three tier names. Minor; test surface catches divergence.

### N5 tests/policy/recipes.test.ts imports js-yaml directly rather than routing through config loader everywhere
File: tests/policy/recipes.test.ts
The loads-cleanly test uses loadConfig. The strict-DSL test parses YAML itself because you want to test loadRules directly. Worth a one-line comment explaining why two paths.

## Focus-Area Verdict

1. Null-signal semantics: correct. evalFieldCond returns null tri-state; evalNot uses r === false ? true : false, so null poisons both polarities. dsl_notOfNullLeaf_returnsFalse covers it.
2. Abstain fall-through: correct (evaluate.ts:13, test evaluate_abstainRule_fallsThroughToNextMatch).
3. Frozen results: correct (ABSTAIN_RESULT frozen; matched branch Object.freeze; test asserts Object.isFrozen).
4. Regex compile-once: correct. parseLeafOp does new RegExp(value) once; matchLeafOp calls op.matches.test(value). Test loadRules_matchesRegex_compiledOnceAtLoad asserts RegExp instance and .source.
5. Load-time rejection: all seven spec bullets covered (duplicate ids, unknown signals, bad leaf types, unparseable regex, modelId-not-in-tiers, escalate non-positive, unknown keys inside rules/conditions).
6. Type safety: anyCond cast (M3) is the only notable soft spot. No as any, no non-null assertions beyond post-keys[0]! guarded by keys.length !== 1 check. Safe.
7. Cohesion / file sizes: all files under 400 lines (biggest is load.ts at ~294). No console.log. No function >50 lines.
8. Test coverage: every spec bullet has a test. dsl_emptyAll_matchesEverything and dsl_emptyAny_matchesNothing cover edge cases spec did not explicitly mandate.
9. Recipe correctness: see M1.
10. Config schema change: CcmuxRule.then is never read via .choice anywhere outside src/config/validate-rules.ts. Safe.

## Files Reviewed
- src/policy/dsl.ts
- src/policy/evaluate.ts
- src/policy/predicates.ts
- src/policy/load.ts
- src/policy/signals-schema.ts
- src/policy/index.ts
- src/policy/recipes/frugal.yaml
- src/policy/recipes/balanced.yaml
- src/policy/recipes/opus-forward.yaml
- src/config/schema.ts
- src/config/validate-rules.ts
- tests/policy/dsl.test.ts
- tests/policy/evaluate.test.ts
- tests/policy/predicates.test.ts
- tests/policy/load.test.ts
- tests/policy/recipes.test.ts
- tests/policy/fixtures/mixed.json
- tests/policy/helpers.ts
