// Result cache for the classifier race (§8.4). Keyed on the canonical request
// hash (which excludes `model`), so a retry of the same request reuses the
// prior classification instead of paying for another Haiku call. In-memory,
// per process; insertion-ordered eviction once `maxEntries` is exceeded.

import type { ClassifierResult } from './types.js';

const DEFAULT_MAX_ENTRIES = 1000;

export interface ClassifierCache {
  get(requestHash: string): ClassifierResult | undefined;
  set(requestHash: string, result: ClassifierResult): void;
  size(): number;
}

export function createClassifierCache(opts: { readonly maxEntries?: number } = {}): ClassifierCache {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const map = new Map<string, ClassifierResult>();

  return {
    get(requestHash) {
      return map.get(requestHash);
    },
    set(requestHash, result) {
      if (!map.has(requestHash) && map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(requestHash, result);
    },
    size() {
      return map.size;
    },
  };
}
