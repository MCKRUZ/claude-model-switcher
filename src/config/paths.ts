// Cross-platform XDG-style path resolver for ccmux.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface CcmuxPaths {
  readonly configDir: string;
  readonly configFile: string;
  readonly logDir: string;
  readonly decisionLogDir: string;
  readonly stateDir: string;
  readonly pidFile: string;
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveConfigDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const ccmuxHome = nonBlank(env.CCMUX_HOME);
  if (ccmuxHome) return ccmuxHome;
  const xdg = nonBlank(env.XDG_CONFIG_HOME);
  if (xdg) return join(xdg, 'ccmux');
  if (platform === 'win32') {
    const appData = nonBlank(env.APPDATA);
    if (appData) return join(appData, 'ccmux');
  }
  return join(homedir(), '.config', 'ccmux');
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CcmuxPaths {
  const configDir = resolveConfigDir(env, platform);
  const logDir = join(configDir, 'logs');
  const decisionLogDir = join(logDir, 'decisions');
  const stateDir = join(configDir, 'state');
  return {
    configDir,
    configFile: join(configDir, 'config.yaml'),
    logDir,
    decisionLogDir,
    stateDir,
    pidFile: join(stateDir, 'ccmux.pid'),
  };
}

export function ensureDirs(paths: CcmuxPaths): void {
  // mode 0o700 is enforced on POSIX only; Windows ignores the bits.
  const dirs = [paths.configDir, paths.logDir, paths.decisionLogDir, paths.stateDir];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
