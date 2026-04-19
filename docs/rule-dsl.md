# Rule DSL

ccmux uses a first-match-wins rule engine. Rules live in the `rules` array of your config. Each rule has a `when` condition and a `then` action.

## Structure

```yaml
rules:
  - id: my-rule
    when:
      planMode: true
    then:
      model: opus
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier for logging |
| `when` | yes | Condition object (see below) |
| `then` | yes | Action: `model` (haiku/sonnet/opus) or `abstain` |
| `allowDowngrade` | no | If false, never route to a cheaper tier than requested |

## Conditions

### Simple conditions

Match directly on extracted signals:

```yaml
when:
  planMode: true
  messageCount:
    gte: 10
  toolUseCount:
    gt: 0
```

All fields in a `when` block are ANDed together.

### Composition: all, any, not

Combine conditions with `all`, `any`, and `not`:

```yaml
when:
  any:
    - planMode: true
    - retryCount:
        gte: 2
    - frustration: true
```

```yaml
when:
  all:
    - messageCount:
        gte: 5
    - not:
        toolUseCount:
          gt: 0
```

### Available signals

| Signal | Type | Description |
|--------|------|-------------|
| `planMode` | boolean | Client is in plan/architect mode |
| `messageCount` | number | Messages in the conversation |
| `tools` | string[] | Tool names available |
| `toolUseCount` | number | Number of tool-use blocks in the request |
| `estInputTokens` | number | Estimated input token count |
| `fileRefCount` | number | File paths referenced in content |
| `retryCount` | number | Retry attempts (from headers) |
| `frustration` | boolean | Frustration markers detected |
| `explicitModel` | string | Model explicitly requested by client |
| `projectPath` | string | Project path from headers |
| `sessionDurationMs` | number | Session duration in milliseconds |
| `betaFlags` | string[] | Beta feature flags |

### Numeric comparisons

```yaml
estInputTokens:
  gt: 5000
  lt: 50000
  gte: 1000
  lte: 10000
```

## First-match-wins

Rules are evaluated top-to-bottom. The first rule whose `when` matches wins. If no rule matches, the classifier runs (heuristic first, then Haiku if enabled).

A rule can `abstain` to explicitly pass to the next rule:

```yaml
then:
  abstain: true
```

## Worked examples

### Plan mode goes to Opus

```yaml
rules:
  - id: plan-mode-opus
    when:
      planMode: true
    then:
      model: opus
```

### High tool count goes to Sonnet

```yaml
rules:
  - id: many-tools-sonnet
    when:
      toolUseCount:
        gte: 3
    then:
      model: sonnet
```

### Short questions go to Haiku

```yaml
rules:
  - id: short-question-haiku
    when:
      all:
        - messageCount:
            lt: 3
        - estInputTokens:
            lt: 2000
        - toolUseCount:
            eq: 0
    then:
      model: haiku
```

## See also

- [Recipes](recipes.md) for batteries-included rule sets
- [Configuration Reference](config-reference.md) for the full config schema
