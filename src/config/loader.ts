// ccmux YAML config loader. Pure-async; no IO at import time.

import { readFile } from 'node:fs/promises';
import { CORE_SCHEMA, load as yamlLoad } from 'js-yaml';
import { defaultConfig } from './defaults.js';
import { resolvePaths } from './paths.js';
import type { CcmuxConfig, ConfigError } from './schema.js';
import { validateConfig } from './validate.js';
import { fail, ok, type Result } from '../types/result.js';

export interface LoadedConfig {
  readonly config: CcmuxConfig;
  readonly warnings: readonly ConfigError[];
}

async function readFileIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadConfig(
  path?: string,
): Promise<Result<LoadedConfig, ConfigError[]>> {
  const resolved = path ?? resolvePaths().configFile;
  const contents = await readFileIfExists(resolved);
  if (contents === null) {
    return ok({ config: defaultConfig(), warnings: [] });
  }
  // anthropic-forward-compat: yaml returns unknown
  let parsed: unknown;
  try {
    parsed = yamlLoad(contents, { schema: CORE_SCHEMA });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail<ConfigError[]>([
      { path: '/', message: `invalid YAML: ${msg}`, severity: 'error' },
    ]);
  }
  const result = validateConfig(parsed);
  if (result.errors.length > 0) {
    return fail<ConfigError[]>([...result.errors]);
  }
  return ok({ config: result.config, warnings: result.warnings });
}
