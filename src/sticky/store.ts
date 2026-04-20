import type { StickyEntry } from './types.js';

const DEFAULT_MAX_ENTRIES = 10_000;

export interface StickyStore {
  get(sessionId: string, now: number): StickyEntry | undefined;
  peek(sessionId: string): StickyEntry | undefined;
  set(entry: StickyEntry): void;
  touch(sessionId: string, now: number): void;
  delete(sessionId: string): boolean;
  size(): number;
}

export interface StickyStoreOptions {
  readonly ttlMs: number;
  readonly maxEntries?: number;
}

function evictOldest(map: Map<string, StickyEntry>): void {
  let oldestKey: string | undefined;
  let oldestSeen = Number.POSITIVE_INFINITY;
  for (const [k, v] of map) {
    if (v.lastSeenAt < oldestSeen) {
      oldestSeen = v.lastSeenAt;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) map.delete(oldestKey);
}

export function createStickyStore(opts: StickyStoreOptions): StickyStore {
  const ttlMs = opts.ttlMs;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const map = new Map<string, StickyEntry>();

  function isExpired(entry: StickyEntry, now: number): boolean {
    return now - entry.lastSeenAt > ttlMs;
  }

  return {
    get(sessionId, now) {
      const entry = map.get(sessionId);
      if (entry === undefined) return undefined;
      if (isExpired(entry, now)) {
        map.delete(sessionId);
        return undefined;
      }
      return entry;
    },
    peek(sessionId) {
      return map.get(sessionId);
    },
    set(entry) {
      if (!map.has(entry.sessionId) && map.size >= maxEntries) {
        evictOldest(map);
      }
      map.set(entry.sessionId, entry);
    },
    touch(sessionId, now) {
      const entry = map.get(sessionId);
      if (entry === undefined) return;
      map.set(sessionId, {
        ...entry,
        lastSeenAt: now,
        turnCount: entry.turnCount + 1,
      });
    },
    delete(sessionId) {
      return map.delete(sessionId);
    },
    size() {
      return map.size;
    },
  };
}
