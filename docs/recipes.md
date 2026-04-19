# Recipes

ccmux ships three policy presets. Use `ccmux init --recipe <name>` to scaffold one.

## balanced (default)

One-line philosophy: Haiku for trivial requests, Opus for planning, Sonnet for everything else. Escalate on retries or frustration.

```yaml
rules:
  - id: plan-mode-opus
    when:
      planMode: true
    then:
      model: opus
  - id: trivial-haiku
    when:
      all:
        - messageCount:
            lt: 5
        - toolUseCount:
            eq: 0
        - estInputTokens:
            lt: 2000
    then:
      model: haiku
  - id: retry-escalate
    when:
      any:
        - retryCount:
            gte: 2
        - frustration: true
    then:
      model: opus
```

**Expected cost profile:** 40-60% cheaper than always-Opus for typical Claude Code sessions. Most short Q&A goes to Haiku, planning stays on Opus, and the middle ground uses Sonnet via the classifier.

**When to pick it:** General-purpose daily use. Good starting point if you are unsure.

## frugal

One-line philosophy: Minimize cost aggressively. Haiku by default, Opus only for explicit planning.

```yaml
rules:
  - id: plan-mode-opus
    when:
      planMode: true
    then:
      model: opus
  - id: short-haiku
    when:
      all:
        - messageCount:
            lt: 6
        - toolUseCount:
            eq: 0
    then:
      model: haiku
  - id: frustration-bump
    when:
      frustration: true
    then:
      model: sonnet
```

**Expected cost profile:** 60-80% cheaper than always-Opus. Trades some response quality on medium-complexity requests for significant savings.

**When to pick it:** Budget-constrained usage, exploratory sessions, or when you do not need Opus quality for most interactions.

## opus-forward

One-line philosophy: Opus by default, Haiku only for trivial openers. Maximum quality.

```yaml
rules:
  - id: trivial-opener-haiku
    when:
      all:
        - messageCount:
            lt: 2
        - estInputTokens:
            lt: 500
        - toolUseCount:
            eq: 0
    then:
      model: haiku
```

**Expected cost profile:** 5-15% cheaper than always-Opus. Only the most trivial requests get downgraded.

**When to pick it:** When quality is paramount and you want marginal savings on throwaway requests.

## Custom recipes

Create your own by editing `~/.config/ccmux/config.yaml` directly. See [Rule DSL](rule-dsl.md) for the full condition syntax and [Configuration Reference](config-reference.md) for all available options.
