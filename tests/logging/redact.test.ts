import { describe, it, expect } from 'vitest';
import { sanitizeHeaders, SANITIZABLE_HEADER_NAMES } from '../../src/privacy/redact.js';

describe('sanitizeHeaders', () => {
  it('redacts authorization, x-api-key, and leaves others untouched', () => {
    const out = sanitizeHeaders({
      authorization: 'Bearer sk-ant-xxx',
      'x-api-key': 'k',
      foo: 'bar',
    });
    expect(out).toEqual({
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      foo: 'bar',
    });
  });

  it('matches header names case-insensitively and preserves original case', () => {
    const out = sanitizeHeaders({
      Authorization: 'Bearer x',
      AUTHORIZATION: 'Bearer y',
      authorization: 'Bearer z',
    });
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.AUTHORIZATION).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(Object.keys(out)).toEqual(['Authorization', 'AUTHORIZATION', 'authorization']);
  });

  it('replaces duplicate (array) values with a single-element [REDACTED] array', () => {
    const out = sanitizeHeaders({
      'x-ccmux-token': ['t1', 't2'],
      via: ['a', 'b'],
    });
    expect(out['x-ccmux-token']).toEqual(['[REDACTED]']);
    expect(out.via).toEqual(['a', 'b']);
  });

  it('leaves undefined values as undefined', () => {
    const out = sanitizeHeaders({ authorization: undefined, foo: 'bar' });
    expect(out.authorization).toBeUndefined();
    expect(out.foo).toBe('bar');
  });

  it('does not mutate input', () => {
    const input = { authorization: 'Bearer x', foo: 'bar' };
    const snapshot = { ...input };
    sanitizeHeaders(input);
    expect(input).toEqual(snapshot);
  });

  it('SANITIZABLE_HEADER_NAMES is exactly the documented lowercased set', () => {
    expect([...SANITIZABLE_HEADER_NAMES].sort()).toEqual(
      ['authorization', 'x-api-key', 'x-ccmux-token'].sort(),
    );
  });
});
