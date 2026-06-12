// Cache-cost observability for mid-session model switches.
//
// Anthropic's prompt cache is keyed per model, so changing the model partway
// through a conversation forces the upstream to rebuild the cache (billed as
// cache_creation tokens) instead of reading it cheaply. With sticky routing
// enabled these switches should be rare — only deliberate escalations — so a
// high count here is the signal that routing is churning models and paying to
// rebuild the cache each time. We surface it rather than block it: the switches
// that survive sticky are quality-driven escalations worth paying for.

import type { DecisionRecord } from '../decisions/types.js';

export interface SwitchSummary {
  readonly totalSwitches: number;
  readonly sessionsWithSwitches: number;
  /** cache_creation tokens billed on the requests immediately after a switch. */
  readonly cacheRebuildTokens: number;
}

export function summarizeSwitches(records: readonly DecisionRecord[]): SwitchSummary {
  const lastModel = new Map<string, string>();
  const switchedSessions = new Set<string>();
  let totalSwitches = 0;
  let cacheRebuildTokens = 0;

  for (const rec of records) {
    // Shadow records never change the served model, so they cannot cause a
    // real cache rebuild — exclude them from switch accounting.
    if (rec.mode === 'shadow') continue;
    const prev = lastModel.get(rec.session_id);
    if (prev !== undefined && prev !== rec.forwarded_model) {
      totalSwitches += 1;
      switchedSessions.add(rec.session_id);
      cacheRebuildTokens += rec.usage?.cache_creation_input_tokens ?? 0;
    }
    lastModel.set(rec.session_id, rec.forwarded_model);
  }

  return {
    totalSwitches,
    sessionsWithSwitches: switchedSessions.size,
    cacheRebuildTokens,
  };
}
