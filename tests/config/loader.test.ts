import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
import { resolvePaths } from '../../src/config/paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'config');

function fx(name: string): string {
  return join(fixtures, name);
}

describe('loadConfig — missing file', () => {
  it('loadConfig_missingFile_returnsDefaults', async () => {
    const r = await loadConfig(join(fixtures, 'does-not-exist.yaml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warnings).toEqual([]);
    expect(r.value.config.port).toBe(8787);
    expect(r.value.config.mode).toBe('live');
    expect(r.value.config.classifier.enabled).toBe(true);
  });
});

describe('loadConfig — minimal fixture', () => {
  it('loadConfig_minimalValid_returnsDefaultsMerged', async () => {
    const r = await loadConfig(fx('minimal.yaml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.port).toBe(9000);
    expect(r.value.config.classifier.timeoutMs).toBe(800);
    expect(r.value.config.logging.rotation.strategy).toBe('daily');
    expect(r.value.warnings).toEqual([]);
  });
});

describe('loadConfig — full canonical fixture', () => {
  it('loadConfig_fullExample_acceptsEveryDocumentedKey', async () => {
    const r = await loadConfig(fx('full.yaml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warnings).toEqual([]);
    expect(r.value.config.rules).toHaveLength(1);
    expect(r.value.config.rules[0]?.id).toBe('plan-mode-opus');
    expect(r.value.config.rules[0]?.then.choice).toBe('opus');
    expect(r.value.config.modelTiers['claude-opus-4-7']).toBe('opus');
    const opusPricing = r.value.config.pricing['claude-opus-4-7'];
    expect(opusPricing?.input).toBe(15);
    expect(opusPricing?.cacheCreate).toBe(18.75);
  });
});

describe('loadConfig — forward compatibility', () => {
  it('loadConfig_unknownTopLevelKey_warnsButSucceeds', async () => {
    const r = await loadConfig(fx('unknown-top.yaml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.value.warnings.find((w) => w.path === '/telemetry');
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('loadConfig_unknownNestedKey_warnsButSucceeds', async () => {
    const r = await loadConfig(fx('unknown-nested.yaml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warn = r.value.warnings.find(
      (w) => w.path === '/classifier/futureFlag',
    );
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });
});

describe('loadConfig — error paths', () => {
  it('loadConfig_invalidYaml_returnsError', async () => {
    const r = await loadConfig(fx('invalid-yaml.yaml'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toHaveLength(1);
    expect(r.error[0]?.path).toBe('/');
    expect(r.error[0]?.severity).toBe('error');
  });

  it('loadConfig_invalidRuleShape_pointsToBadPath', async () => {
    const r = await loadConfig(fx('invalid-rule.yaml'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const missing = r.error.find((e) => e.path === '/rules/0/then/choice');
    expect(missing).toBeDefined();
  });

  it('loadConfig_invalidEnum_pointsToBadPath', async () => {
    const r = await loadConfig(fx('invalid-enum.yaml'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = r.error.find((e) => e.path === '/mode');
    expect(err).toBeDefined();
  });

  it('loadConfig_badPricing_pointsToModel', async () => {
    const r = await loadConfig(fx('bad-pricing.yaml'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = r.error.find(
      (e) => e.path === '/pricing/claude-opus-4-7/input',
    );
    expect(err).toBeDefined();
  });
});

describe('loadConfig — cross-platform paths', () => {
  it('loadConfig_crossPlatformPath_resolves', () => {
    const posix = resolvePaths(
      { XDG_CONFIG_HOME: '/home/u/.config' },
      'linux',
    );
    expect(posix.configFile).toBe(join('/home/u/.config', 'ccmux', 'config.yaml'));

    const win = resolvePaths(
      { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      'win32',
    );
    expect(win.configFile).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'ccmux', 'config.yaml'),
    );
  });

  it('loadConfig_ccmuxHomeEnv_overridesDefault', () => {
    const paths = resolvePaths({ CCMUX_HOME: '/opt/ccmux' }, 'linux');
    expect(paths.configFile).toBe(join('/opt/ccmux', 'config.yaml'));
  });
});
