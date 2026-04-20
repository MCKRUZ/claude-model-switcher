// Shared pino logger factory with fixed auth-header redaction.

import { join } from 'node:path';
import pino, { type Logger, type LoggerOptions as PinoOptions, type LevelWithSilent } from 'pino';
import { sanitizeHeaders } from '../privacy/redact.js';

export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-ccmux-token"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-ccmux-token"]',
  'err.config.headers.authorization',
];

const CENSOR = '[REDACTED]';

type WithMaybeHeaders = { headers?: Record<string, string | string[] | undefined> };

function serializeReq(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const { raw: _raw, ...rest } = obj;
  const headers = (rest as WithMaybeHeaders).headers;
  if (!headers || typeof headers !== 'object') return rest;
  return { ...rest, headers: sanitizeHeaders(headers) };
}

export interface LoggerOptions {
  readonly destination: 'stderr' | 'file';
  readonly logDir?: string;
  readonly level?: LevelWithSilent;
  readonly env?: NodeJS.ProcessEnv;
}

function isLevel(value: string): value is LevelWithSilent {
  return ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(
    value,
  );
}

function resolveLevel(opts: LoggerOptions): LevelWithSilent {
  if (opts.level) return opts.level;
  const env = opts.env ?? process.env;
  const explicit = env.CCMUX_LOG_LEVEL;
  if (explicit && isLevel(explicit)) return explicit;
  if (env.CCMUX_DEBUG === '1') return 'debug';
  return 'info';
}

function buildDestination(opts: LoggerOptions): pino.DestinationStream {
  if (opts.destination === 'file') {
    if (!opts.logDir) {
      throw new Error('createLogger: logDir is required when destination="file"');
    }
    return pino.destination({
      dest: join(opts.logDir, 'ccmux.log'),
      sync: false,
      mkdir: false,
    });
  }
  return pino.destination(2);
}

export function createLogger(opts: LoggerOptions): Logger {
  const pinoOpts: PinoOptions = {
    level: resolveLevel(opts),
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    serializers: { req: serializeReq },
  };
  return pino(pinoOpts, buildDestination(opts));
}

export function childLogger(
  logger: Logger,
  bindings: Record<string, unknown>,
): Logger {
  return logger.child(bindings);
}
