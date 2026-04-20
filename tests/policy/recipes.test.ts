import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load as yamlLoad, CORE_SCHEMA } from 'js-yaml';
import { loadConfig } from '../../src/config/loader.js';
import { loadRules } from '../../src/policy/load.js';
import { evaluate } from '../../src/policy/evaluate.js';
import type { Signals } from '../../src/signals/types.js';
import { makeSignals } from './helpers.js';

interface MixedFixture {
  readonly name: string;
  readonly planMode: boolean;
  readonly messageCount: number;
  readonly toolUseCount: number;
  readonly estInputTokens: number;
  readonly frustration: boolean;
  readonly retryCount: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const mixedFixtures: readonly MixedFixture[] = JSON.parse(readFileSync(join(here, 'fixtures', 'mixed.json'), 'utf-8'));
const RECIPE_DIR = join(here, '..', '..', 'src', 'policy', 'recipes');

function recipePath(name: string): string {
  return join(RECIPE_DIR, `${name}.yaml`);
}

function signalsFromFixture(f: MixedFixture): Signals {
  return makeSignals({
    planMode: f.planMode,
    messageCount: f.messageCount,
    toolUseCount: f.toolUseCount,
    estInputTokens: f.estInputTokens,
    frustration: f.frustration,
    retryCount: f.retryCount,
  });
}

async function loadRecipeRules(name: string): Promise<ReturnType<typeof loadRules>> {
  const yamlText = readFileSync(recipePath(name), 'utf8');
  const parsed = yamlLoad(yamlText, { schema: CORE_SCHEMA }) as { rules?: unknown };
  return loadRules(parsed.rules, { modelTiers: {} });
}

describe('recipes — load cleanly via section-03 loader', () => {
  it.each(['frugal', 'balanced', 'opus-forward'] as const)(
    'recipes_%sYaml_loadsWithoutErrors',
    async (name) => {
      const r = await loadConfig(recipePath(name));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.config.rules.length).toBeGreaterThan(0);
      }
    },
  );
});

describe('recipes — strict DSL validation', () => {
  it.each(['frugal', 'balanced', 'opus-forward'] as const)(
    'recipes_%s_passesStrictLoad',
    async (name) => {
      const r = await loadRecipeRules(name);
      expect(r.ok).toBe(true);
    },
  );
});

describe('recipes — balanced routing ratio', () => {
  it('recipes_balanced_routesAtLeast30PercentToHaikuDirectly', async () => {
    const r = await loadRecipeRules('balanced');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rules = r.value;
    const haikuMatches = mixedFixtures
      .map(signalsFromFixture)
      .map((s) => evaluate(rules, s))
      .filter((v) => v.kind === 'matched' && 'choice' in v.result && v.result.choice === 'haiku');
    const ratio = haikuMatches.length / mixedFixtures.length;
    expect(ratio).toBeGreaterThanOrEqual(0.3);
  });
});

describe('recipes — opus-forward routing ratio', () => {
  it('recipes_opusForward_routesMostNonTrivialToOpus', async () => {
    const r = await loadRecipeRules('opus-forward');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rules = r.value;
    const decisions = mixedFixtures.map(signalsFromFixture).map((s) => evaluate(rules, s));
    const nonHaiku = decisions.filter(
      (d) => !(d.kind === 'matched' && 'choice' in d.result && d.result.choice === 'haiku'),
    );
    const opusCount = nonHaiku.filter(
      (d) => d.kind === 'matched' && 'choice' in d.result && d.result.choice === 'opus',
    ).length;
    const ratio = opusCount / nonHaiku.length;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
  });
});

describe('recipes — frugal routing for tiny requests', () => {
  it('recipes_frugal_emitsHaikuForEveryTinyRequest', async () => {
    const r = await loadRecipeRules('frugal');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rules = r.value;
    for (const f of mixedFixtures) {
      if (f.messageCount < 6 && f.toolUseCount === 0 && !f.planMode && !f.frustration) {
        const result = evaluate(rules, signalsFromFixture(f));
        expect(result.kind, `fixture ${f.name}`).toBe('matched');
        if (result.kind === 'matched' && 'choice' in result.result) {
          expect(result.result.choice, `fixture ${f.name}`).toBe('haiku');
        }
      }
    }
  });
});
