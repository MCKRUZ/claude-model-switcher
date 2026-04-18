import type { Tier } from '../config/schema.js';

export type { Tier };

export interface StickyEntry {
  readonly sessionId: string;
  readonly tier: Tier;
  readonly modelId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly turnCount: number;
}

export type StickyChosenBy = 'explicit' | 'policy' | 'sticky' | 'escalate';
export type StickyAbstainReason = 'no-sticky' | 'ttl-expired' | 'downgrade-blocked';

export type StickyDecision =
  | {
      readonly kind: 'chosen';
      readonly modelId: string;
      readonly tier: Tier;
      readonly chosenBy: StickyChosenBy;
    }
  | {
      readonly kind: 'abstain';
      readonly reason: StickyAbstainReason;
      readonly sticky?: StickyEntry;
    };
