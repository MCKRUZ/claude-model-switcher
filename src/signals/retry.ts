// Retry count: repetition of requestHash within the current session.
// Delegates counting to the sessionContext callback (store lives in section-09).

import type { SessionContext } from './types.js';

export function retryCount(hash: string, ctx: SessionContext): number {
  const n = ctx.retrySeen(hash);
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
