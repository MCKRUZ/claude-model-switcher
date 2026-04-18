// Signals — frozen input shape shared by policy engine, classifier, and feedback.
// Contract is consumed verbatim by sections 08, 11/12, and beyond.

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
}

export interface SessionContext {
  readonly createdAt: number;
  retrySeen(hash: string): number;
}
