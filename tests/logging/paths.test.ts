import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { resolvePaths, ensureDirs } from '../../src/config/paths.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccmux-paths-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  it('honors CCMUX_HOME over everything else', () => {
    const p = resolvePaths(
      { CCMUX_HOME: tmp, XDG_CONFIG_HOME: '/should/not/win', APPDATA: 'C:\\nope' },
      'linux',
    );
    expect(p.configDir).toBe(tmp);
  });

  it('honors XDG_CONFIG_HOME when CCMUX_HOME is unset', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: tmp }, 'linux');
    expect(p.configDir).toBe(join(tmp, 'ccmux'));
  });

  it('falls back to ~/.config/ccmux on Linux/macOS with no env hints', () => {
    const p = resolvePaths({}, 'linux');
    expect(p.configDir).toBe(join(homedir(), '.config', 'ccmux'));
  });

  it('uses %APPDATA%\\ccmux on Windows when APPDATA is set', () => {
    const p = resolvePaths({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32');
    expect(p.configDir).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'ccmux'));
  });

  it('falls back to ~/.config/ccmux on Windows when APPDATA is missing', () => {
    const p = resolvePaths({}, 'win32');
    expect(p.configDir).toBe(join(homedir(), '.config', 'ccmux'));
  });

  it('derives configFile, logDir, decisionLogDir, stateDir, pidFile from configDir', () => {
    const p = resolvePaths({ CCMUX_HOME: tmp }, 'linux');
    expect(p.configFile).toBe(join(tmp, 'config.yaml'));
    expect(p.logDir).toBe(join(tmp, 'logs'));
    expect(p.decisionLogDir).toBe(join(tmp, 'logs', 'decisions'));
    expect(p.stateDir).toBe(join(tmp, 'state'));
    expect(p.pidFile).toBe(join(tmp, 'state', 'ccmux.pid'));
  });

  it('uses the platform-native path separator', () => {
    const p = resolvePaths({ CCMUX_HOME: tmp }, process.platform);
    expect(p.configFile.includes(sep)).toBe(true);
  });
});

describe('ensureDirs', () => {
  it('creates configDir, logDir, decisionLogDir, stateDir when none exist', () => {
    const p = resolvePaths({ CCMUX_HOME: join(tmp, 'fresh') }, 'linux');
    ensureDirs(p);
    expect(statSync(p.configDir).isDirectory()).toBe(true);
    expect(statSync(p.logDir).isDirectory()).toBe(true);
    expect(statSync(p.decisionLogDir).isDirectory()).toBe(true);
    expect(statSync(p.stateDir).isDirectory()).toBe(true);
  });

  it('is idempotent — calling twice does not throw', () => {
    const p = resolvePaths({ CCMUX_HOME: tmp }, 'linux');
    ensureDirs(p);
    expect(() => ensureDirs(p)).not.toThrow();
  });

  it('propagates non-EEXIST errors when a path component is a file, not a dir', () => {
    const parent = join(tmp, 'parent-is-file');
    writeFileSync(parent, 'not a dir');
    const p = resolvePaths({ CCMUX_HOME: join(parent, 'ccmux') }, 'linux');
    expect(() => ensureDirs(p)).toThrow();
  });
});
