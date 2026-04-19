// Static classifier prompt for the Haiku-backed classifier (§12).
//
// IMPORTANT: changes here invalidate Anthropic's prompt cache for the
// classifier path. Bump CLASSIFIER_PROMPT_VERSION on every edit so cache
// metrics in §17 can attribute hit-rate drops to a known revision.
//
// The exported constants are consumed verbatim by `src/classifier/haiku.ts`
// to construct an outbound body that is byte-stable across calls (only the
// last user message varies).

export const CLASSIFIER_PROMPT_VERSION = 'v1' as const;

/**
 * System-prompt body marked with `cache_control: { type: 'ephemeral' }` in
 * the outbound `system` block. Keep under ~500 tokens so cache-hit ratios
 * dominate cost.
 */
export const CLASSIFIER_PROMPT = [
  'You classify a Claude Code request by complexity and recommend a model tier.',
  '',
  'Tiers:',
  '- "haiku": trivial, lookup, formatting, single-line edits, simple Q&A.',
  '- "sonnet": ordinary coding, single-file changes, normal reasoning.',
  '- "opus": multi-file refactors, architectural decisions, deep debugging,',
  '  long contexts, broad tool use, or anything requiring sustained reasoning.',
  '',
  'Score complexity on a 0-10 scale (0 trivial, 10 requires Opus-level depth).',
  'Confidence is your self-reported certainty in [0, 1].',
  '',
  'Respond with STRICT JSON ONLY, on a single line, no markdown fences,',
  'no commentary. Schema:',
  '{"complexity":<0-10 number>,"suggestedModel":"opus"|"sonnet"|"haiku",',
  '"confidence":<0-1 number>,"rationale":"<short string, optional>"}',
].join('\n');
