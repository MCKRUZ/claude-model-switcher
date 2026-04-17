import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { createLogger, childLogger, REDACT_PATHS } from '../../src/logging/logger.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccmux-logger-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

import { sanitizeHeaders } from '../../src/privacy/redact.js';

function captureLogger(env: NodeJS.ProcessEnv = {}): {
  log: pino.Logger;
  read: () => string;
} {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  const log = pino(
    {
      level: env.CCMUX_LOG_LEVEL ?? 'info',
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
      serializers: {
        req: (v: unknown) => {
          if (v === null || typeof v !== 'object') return v;
          const o = v as { headers?: Record<string, string | string[] | undefined> };
          if (!o.headers) return v;
          return { ...(v as object), headers: sanitizeHeaders(o.headers) };
        },
      },
    },
    stream,
  );
  return { log, read: () => chunks.join('') };
}

describe('createLogger — redaction', () => {
  it('redacts req.headers.authorization', () => {
    const { log, read } = captureLogger();
    log.info({ req: { headers: { authorization: 'Bearer sk-ant-xxx' } } }, 'hi');
    const out = read();
    expect(out).not.toContain('sk-ant-xxx');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts req.headers["x-api-key"]', () => {
    const { log, read } = captureLogger();
    log.info({ req: { headers: { 'x-api-key': 'secret-key' } } }, 'hi');
    expect(read()).not.toContain('secret-key');
  });

  it('redacts req.headers["x-ccmux-token"]', () => {
    const { log, read } = captureLogger();
    log.info({ req: { headers: { 'x-ccmux-token': 'token-xyz' } } }, 'hi');
    expect(read()).not.toContain('token-xyz');
  });

  it('passes non-sensitive fields through unchanged', () => {
    const { log, read } = captureLogger();
    log.info({ req: { method: 'POST', url: '/v1/messages' } }, 'hello');
    const parsed = JSON.parse(read().trim().split('\n')[0] ?? '{}') as {
      msg?: string;
      req?: { method?: string; url?: string };
    };
    expect(parsed.msg).toBe('hello');
    expect(parsed.req?.method).toBe('POST');
    expect(parsed.req?.url).toBe('/v1/messages');
  });
});

describe('createLogger — destination', () => {
  it('writes to a file when destination="file"', async () => {
    const log = createLogger({ destination: 'file', logDir: tmp });
    log.info('file-write-test');
    const file = join(tmp, 'ccmux.log');
    await new Promise<void>((r) => log.flush(() => r()));
    for (let i = 0; i < 40; i++) {
      if (existsSync(file) && readFileSync(file, 'utf8').includes('file-write-test')) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('file-write-test');
  });

  it('throws when destination="file" and logDir is missing', () => {
    expect(() => createLogger({ destination: 'file' })).toThrow(/logDir is required/);
  });
});

describe('createLogger — level resolution', () => {
  it('respects CCMUX_LOG_LEVEL from env', () => {
    const log = createLogger({ destination: 'stderr', env: { CCMUX_LOG_LEVEL: 'debug' } });
    expect(log.level).toBe('debug');
  });

  it('upgrades to debug when CCMUX_DEBUG=1', () => {
    const log = createLogger({ destination: 'stderr', env: { CCMUX_DEBUG: '1' } });
    expect(log.level).toBe('debug');
  });

  it('defaults to info when no env hint is given', () => {
    const log = createLogger({ destination: 'stderr', env: {} });
    expect(log.level).toBe('info');
  });
});

describe('childLogger', () => {
  it('binds the given fields to every subsequent record', () => {
    const { log, read } = captureLogger();
    const child = childLogger(log, { request_hash: 'abc123' });
    child.info('bound');
    const parsed = JSON.parse(read().trim()) as { request_hash?: string; msg?: string };
    expect(parsed.request_hash).toBe('abc123');
    expect(parsed.msg).toBe('bound');
  });
});
