// Plan-mode marker detection. Scans `system` (string or ContentBlock[]).
// Returns null only when the system field is present but unparseable.

import type { AnthropicContent } from '../types/anthropic.js';
import { flattenText } from './messages.js';

// Claude Code injects "Plan mode is active" inside a system-reminder block when
// the user toggles plan mode. Match case-insensitive to tolerate minor variants.
const MARKER = /plan mode is active/i;

export function detectPlanMode(system: AnthropicContent | undefined): boolean | null {
  if (system === undefined || system === null) return false;
  if (typeof system === 'string') return MARKER.test(system);
  if (!Array.isArray(system)) return null;
  const joined = flattenText(system);
  return MARKER.test(joined);
}
