// Signals — frozen input shape shared by policy engine, classifier, and feedback.
// Contract is consumed verbatim by sections 08, 11/12, and beyond.

// Kinds of changing value the cache-buster detector can find, in report order.
export const CACHE_BUSTER_KINDS = ["date", "time", "uuid", "hex_id"] as const;
export type CacheBusterKind = (typeof CACHE_BUSTER_KINDS)[number];

// Finding for a request whose cached prefix changed only by masked values.
// Holds a salted-HMAC fingerprint and kind labels only — never prompt text.
export interface CacheBusterFinding {
  readonly kinds: readonly CacheBusterKind[];
  readonly prefix_fingerprint: string;
}

export interface Signals {
  readonly planMode: boolean | null;
  readonly messageCount: number;
  readonly tools: readonly string[];
  readonly toolUseCount: number;
  readonly estInputTokens: number;
  readonly fileRefCount: number;
  readonly retryCount: number;
  readonly frustration: boolean | null;
  readonly explicitModel: string | null;
  readonly projectPath: string | null;
  readonly sessionDurationMs: number;
  readonly betaFlags: readonly string[];
  readonly sessionId: string;
  readonly requestHash: string;
  // Present only when the request was flagged. Deliberately NOT in the policy
  // KNOWN_SIGNALS allow-list: rules cannot read it, so routing is unaffected.
  readonly cacheBuster?: CacheBusterFinding;
}

export interface SessionContext {
  readonly createdAt: number;
  retrySeen(hash: string): number;
}
