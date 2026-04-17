// TypeScript types for the ccmux configuration file.
// Validator lives in ./validate.ts; loader lives in ./loader.ts.

export interface ConfigError {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export type ConfigMode = 'live' | 'shadow';
export type ContentMode = 'hashed' | 'full' | 'none';
export type RotationStrategy = 'daily' | 'size' | 'none';
export type Tier = 'haiku' | 'sonnet' | 'opus';

export interface CcmuxRule {
  readonly id: string;
  readonly when: Readonly<Record<string, unknown>>;
  readonly then: { readonly choice: string; readonly [key: string]: unknown };
  readonly allowDowngrade?: boolean;
}

export interface ClassifierThresholds {
  readonly haiku: number;
  readonly heuristic: number;
}

export interface ClassifierConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly timeoutMs: number;
  readonly confidenceThresholds: ClassifierThresholds;
}

export interface StickyModelConfig {
  readonly enabled: boolean;
  readonly sessionTtlMs: number;
}

export interface LoggingRotation {
  readonly strategy: RotationStrategy;
  readonly keep: number;
  readonly maxMb: number;
}

export interface LoggingConfig {
  readonly content: ContentMode;
  readonly fsync: boolean;
  readonly rotation: LoggingRotation;
}

export interface DashboardConfig {
  readonly port: number;
}

export interface PricingEntry {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

export interface SecurityConfig {
  readonly requireProxyToken: boolean;
}

export interface CcmuxConfig {
  readonly port: number;
  readonly mode: ConfigMode;
  readonly security: SecurityConfig;
  readonly rules: readonly CcmuxRule[];
  readonly classifier: ClassifierConfig;
  readonly stickyModel: StickyModelConfig;
  readonly modelTiers: Readonly<Record<string, Tier>>;
  readonly logging: LoggingConfig;
  readonly dashboard: DashboardConfig;
  readonly pricing: Readonly<Record<string, PricingEntry>>;
}

export interface ValidateResult {
  readonly config: CcmuxConfig;
  readonly errors: readonly ConfigError[];
  readonly warnings: readonly ConfigError[];
}
