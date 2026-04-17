import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/validate.js';

describe('schema — port range', () => {
  it('schema_portOutOfRange_fails', () => {
    const low = validateConfig({ port: 0 });
    expect(low.errors.some((e) => e.path === '/port')).toBe(true);

    const high = validateConfig({ port: 70000 });
    expect(high.errors.some((e) => e.path === '/port')).toBe(true);
  });
});

describe('schema — logging enums', () => {
  it('schema_loggingContent_enumEnforced', () => {
    const r = validateConfig({ logging: { content: 'verbose' } });
    expect(r.errors.some((e) => e.path === '/logging/content')).toBe(true);
  });

  it('schema_rotationStrategy_enumEnforced', () => {
    const r = validateConfig({
      logging: { rotation: { strategy: 'hourly' } },
    });
    expect(r.errors.some((e) => e.path === '/logging/rotation/strategy')).toBe(
      true,
    );
  });
});

describe('schema — model tiers', () => {
  it('schema_modelTiers_valueEnumEnforced', () => {
    const r = validateConfig({ modelTiers: { 'some-model': 'ultra' } });
    expect(r.errors.some((e) => e.path === '/modelTiers/some-model')).toBe(
      true,
    );
  });
});

describe('schema — sticky model', () => {
  it('schema_stickyModel_ttlNonNegative', () => {
    const r = validateConfig({ stickyModel: { sessionTtlMs: -1 } });
    expect(
      r.errors.some((e) => e.path === '/stickyModel/sessionTtlMs'),
    ).toBe(true);
  });
});

describe('schema — rule shape at load time', () => {
  it('schema_rule_withOnlyIdAndThen_isValid', () => {
    const r = validateConfig({
      rules: [{ id: 'r1', when: {}, then: { choice: 'opus' } }],
    });
    expect(r.errors).toEqual([]);
    expect(r.config.rules).toHaveLength(1);
    expect(r.config.rules[0]?.id).toBe('r1');
  });

  it('schema_rule_duplicateId_errorsAtSecondOccurrence', () => {
    const r = validateConfig({
      rules: [
        { id: 'r1', when: {}, then: { choice: 'opus' } },
        { id: 'r1', when: {}, then: { choice: 'haiku' } },
      ],
    });
    const dup = r.errors.find((e) => e.path === '/rules/1/id');
    expect(dup).toBeDefined();
    expect(dup?.message).toMatch(/duplicate/);
  });
});

describe('schema — null root', () => {
  it('schema_nullRoot_returnsDefaults', () => {
    const r = validateConfig(null);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.config.port).toBe(8787);
  });
});
