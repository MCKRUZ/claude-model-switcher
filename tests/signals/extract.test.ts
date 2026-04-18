import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { PassThrough } from 'node:stream';
import { extractSignals } from '../../src/signals/extract.js';
import { detectPlanMode } from '../../src/signals/plan-mode.js';
import { detectFrustration } from '../../src/signals/frustration.js';
import { estimateInputTokens } from '../../src/signals/tokens.js';
import { extractToolNames, countFileRefs, countToolUse } from '../../src/signals/tools.js';
import { buildCanonicalInput, requestHash } from '../../src/signals/canonical.js';
import { deriveSessionId, __resetLocalSaltForTests } from '../../src/signals/session.js';
import { extractBetaFlags } from '../../src/signals/beta.js';
import { flattenText, lastUserMessage } from '../../src/signals/messages.js';
import type { SessionContext } from '../../src/signals/types.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' }, new PassThrough());
}

function captureLogger(sink: { warnings: Array<Record<string, unknown>> }): pino.Logger {
  const base = silentLogger();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'warn') {
        return (payload: unknown, _msg?: string) => {
          if (payload && typeof payload === 'object') {
            sink.warnings.push(payload as Record<string, unknown>);
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as pino.Logger;
}

function fakeCtx(retryMap: Record<string, number> = {}): SessionContext {
  return {
    createdAt: Date.now() - 1234,
    retrySeen: (hash: string) => retryMap[hash] ?? 0,
  };
}

describe('flattenText', () => {
  it('returns string content unchanged', () => {
    expect(flattenText('hello')).toBe('hello');
  });
  it('joins text blocks with newlines and skips non-text', () => {
    const text = flattenText([
      { type: 'text', text: 'one' },
      { type: 'image', source: 'x' },
      { type: 'text', text: 'two' },
    ]);
    expect(text).toBe('one\ntwo');
  });
  it('returns empty string on undefined', () => {
    expect(flattenText(undefined)).toBe('');
  });
});

describe('lastUserMessage', () => {
  it('picks the most recent user message and flattens it', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [{ type: 'text', text: 'latest' }] },
    ];
    expect(lastUserMessage(msgs)).toBe('latest');
  });
  it('returns null when no user messages', () => {
    expect(lastUserMessage([{ role: 'assistant', content: 'x' }])).toBe(null);
  });
});

describe('plan-mode detection', () => {
  it('detects marker when system is a string', () => {
    expect(detectPlanMode('Plan mode is active. Do not modify files.')).toBe(true);
  });
  it('detects marker when system is a ContentBlock[]', () => {
    expect(
      detectPlanMode([
        { type: 'text', text: 'normal system' },
        { type: 'text', text: '<system-reminder>\nPlan mode is active.' },
      ]),
    ).toBe(true);
  });
  it('returns false when system is absent or marker missing', () => {
    expect(detectPlanMode(undefined)).toBe(false);
    expect(detectPlanMode('no marker')).toBe(false);
  });
});

describe('token estimate', () => {
  it('returns zero on empty input', () => {
    expect(estimateInputTokens(undefined, undefined)).toBe(0);
  });
  it('grows roughly with input length', () => {
    const short = estimateInputTokens('hi', undefined);
    const long = estimateInputTokens('hi '.repeat(500), undefined);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short * 10);
  });
  it('counts system + message text', () => {
    const n = estimateInputTokens('system bits', [
      { role: 'user', content: 'user bits' },
      { role: 'assistant', content: [{ type: 'text', text: 'assistant bits' }] },
    ]);
    expect(n).toBeGreaterThan(3);
  });
});

describe('tools extractor', () => {
  it('extracts tool names sorted and deduped', () => {
    const names = extractToolNames([
      { name: 'write' },
      { name: 'read_file' },
      { name: 'write' },
      { name: 'edit' },
    ]);
    expect(names).toEqual(['edit', 'read_file', 'write']);
    expect(Object.isFrozen(names)).toBe(true);
  });
  it('counts tool_use blocks in assistant messages', () => {
    const n = countToolUse([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', name: 'read_file', input: { path: '/a/b.ts' } },
        { type: 'tool_use', name: 'edit', input: {} },
      ] },
    ]);
    expect(n).toBe(2);
  });
  it('counts file-ref tool_use blocks (read_file, write, edit)', () => {
    const n = countFileRefs([
      { role: 'assistant', content: [
        { type: 'tool_use', name: 'read_file', input: {} },
        { type: 'tool_use', name: 'bash', input: {} },
        { type: 'tool_use', name: 'write', input: {} },
        { type: 'tool_use', name: 'edit', input: {} },
      ] },
    ]);
    expect(n).toBe(3);
  });
});

describe('frustration detection', () => {
  it('detects trigger phrases case-insensitively', () => {
    expect(detectFrustration([{ role: 'user', content: 'No, that did not work' }])).toBe(true);
    expect(detectFrustration([{ role: 'user', content: 'Why did you delete that?' }])).toBe(true);
    expect(detectFrustration([{ role: 'user', content: "That's wrong." }])).toBe(true);
    expect(detectFrustration([{ role: 'user', content: 'STOP please' }])).toBe(true);
  });
  it('does not match substrings of other words', () => {
    expect(detectFrustration([{ role: 'user', content: 'stopper note nope' }])).toBe(false);
  });
  it('returns null when no user message is present', () => {
    expect(detectFrustration([{ role: 'assistant', content: 'hi' }])).toBe(null);
  });
});

describe('beta flags', () => {
  it('splits, trims, dedupes, and sorts', () => {
    const out = extractBetaFlags({ 'anthropic-beta': 'b,a, c ,a' });
    expect(out).toEqual(['a', 'b', 'c']);
    expect(Object.isFrozen(out)).toBe(true);
  });
  it('returns empty array when header is absent', () => {
    expect(extractBetaFlags({})).toEqual([]);
  });
  it('handles array-valued headers', () => {
    expect(extractBetaFlags({ 'anthropic-beta': ['x,y', 'z'] })).toEqual(['x', 'y', 'z']);
  });
});

describe('canonical hash', () => {
  const ctx = fakeCtx();
  const logger = silentLogger();
  const baseBody = {
    model: 'claude-opus-4-7',
    system: 'sys',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ],
    tools: [{ name: 'edit' }, { name: 'read_file' }],
  };
  it('is stable across key-order permutations', () => {
    const a = extractSignals(baseBody, {}, ctx, logger).requestHash;
    const b = extractSignals(
      {
        messages: baseBody.messages,
        tools: baseBody.tools,
        system: baseBody.system,
        model: baseBody.model,
      },
      {},
      ctx,
      logger,
    ).requestHash;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
  it('excludes model (changing only model yields identical hash)', () => {
    const a = extractSignals(baseBody, {}, ctx, logger).requestHash;
    const b = extractSignals({ ...baseBody, model: 'claude-haiku-4-5' }, {}, ctx, logger).requestHash;
    expect(a).toBe(b);
  });
  it('excludes request IDs, timestamps, and metadata.user_id', () => {
    const a = extractSignals(baseBody, {}, ctx, logger).requestHash;
    const b = extractSignals(
      { ...baseBody, request_id: 'req_123', created_at: 1, metadata: { user_id: 'u_abc' } },
      {},
      ctx,
      logger,
    ).requestHash;
    expect(a).toBe(b);
  });
  it('buildCanonicalInput + requestHash produces deterministic hex', () => {
    const c = buildCanonicalInput(baseBody as never, ['edit', 'read_file'], []);
    expect(requestHash(c)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('sessionId', () => {
  beforeEach(() => __resetLocalSaltForTests());
  it('uses metadata.user_id when valid printable-ASCII string', () => {
    const id = deriveSessionId({ metadata: { user_id: 'user-abc.123' } }, []);
    expect(id).toBe('user-abc.123');
  });
  it('rejects user_id with non-printable or oversized input', () => {
    expect(deriveSessionId({ metadata: { user_id: 'bad\nnewline' } }, [])).not.toBe('bad\nnewline');
    expect(deriveSessionId({ metadata: { user_id: 'a'.repeat(257) } }, [])).toMatch(/^[0-9a-f]{32}$/);
  });
  it('falls back to HMAC when user_id absent', () => {
    const id = deriveSessionId({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, ['t']);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
  it('localSalt stays constant within a process but is not derivable from public input', () => {
    const body = { system: 's', messages: [{ role: 'user', content: 'hi' }] };
    const a = deriveSessionId(body, []);
    const b = deriveSessionId(body, []);
    expect(a).toBe(b);
    __resetLocalSaltForTests();
    const c = deriveSessionId(body, []);
    expect(c).not.toBe(a);
  });
});

describe('extractSignals orchestrator', () => {
  it('returns frozen Signals with expected shape', () => {
    const s = extractSignals(
      {
        model: 'claude-opus-4-7',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'edit' }],
      },
      { 'anthropic-beta': 'beta-a,beta-b' },
      fakeCtx(),
      silentLogger(),
    );
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.tools)).toBe(true);
    expect(Object.isFrozen(s.betaFlags)).toBe(true);
    expect(s.messageCount).toBe(1);
    expect(s.explicitModel).toBe('claude-opus-4-7');
    expect(s.tools).toEqual(['edit']);
    expect(s.betaFlags).toEqual(['beta-a', 'beta-b']);
    expect(s.requestHash).toMatch(/^[0-9a-f]{32}$/);
    expect(s.sessionId).toMatch(/[0-9a-f]{32}|.+/);
    expect(s.sessionDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('retryCount reflects sessionContext.retrySeen result', () => {
    const logger = silentLogger();
    const body = { system: 's', messages: [{ role: 'user', content: 'q' }] };
    const first = extractSignals(body, {}, fakeCtx(), logger);
    const again = extractSignals(body, {}, fakeCtx({ [first.requestHash]: 2 }), logger);
    expect(first.retryCount).toBe(0);
    expect(again.retryCount).toBe(2);
  });

  it('sessionDurationMs reflects Date.now - createdAt', () => {
    const ctx: SessionContext = { createdAt: Date.now() - 5000, retrySeen: () => 0 };
    const s = extractSignals({ messages: [{ role: 'user', content: 'x' }] }, {}, ctx, silentLogger());
    expect(s.sessionDurationMs).toBeGreaterThanOrEqual(5000);
    expect(s.sessionDurationMs).toBeLessThan(10000);
  });

  it('projectPath = longest common prefix of absolute paths in recent tool_use', () => {
    const s = extractSignals(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'read_file', input: { path: '/repo/src/a.ts' } },
              { type: 'tool_use', name: 'edit', input: { path: '/repo/src/b.ts' } },
            ],
          },
        ],
      },
      {},
      fakeCtx(),
      silentLogger(),
    );
    expect(s.projectPath).toBe('/repo/src/');
  });

  it('projectPath is null when no absolute paths are present', () => {
    const s = extractSignals(
      { messages: [{ role: 'user', content: 'x' }] },
      {},
      fakeCtx(),
      silentLogger(),
    );
    expect(s.projectPath).toBe(null);
  });

  it('explicitModel captured from request body', () => {
    const s = extractSignals(
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] },
      {},
      fakeCtx(),
      silentLogger(),
    );
    expect(s.explicitModel).toBe('claude-sonnet-4-6');
  });

  it('a throwing extractor degrades its field and logs a warning without failing', () => {
    const sink = { warnings: [] as Array<Record<string, unknown>> };
    const logger = captureLogger(sink);
    const throwingCtx: SessionContext = {
      createdAt: Date.now(),
      retrySeen: () => {
        throw new Error('boom from retrySeen');
      },
    };
    const s = extractSignals(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      {},
      throwingCtx,
      logger,
    );
    expect(s.retryCount).toBe(0);
    expect(Object.isFrozen(s)).toBe(true);
    expect(sink.warnings.some((w) => w.extractor === 'retry')).toBe(true);
  });

  it('orchestrator never throws even on fully-malformed input', () => {
    expect(() =>
      extractSignals(
        null,
        undefined as never,
        { createdAt: Date.now(), retrySeen: () => 0 },
        silentLogger(),
      ),
    ).not.toThrow();
    const s = extractSignals(
      'not an object',
      {},
      { createdAt: Date.now(), retrySeen: () => 0 },
      silentLogger(),
    );
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.messageCount).toBe(0);
    expect(s.tools).toEqual([]);
  });
});
