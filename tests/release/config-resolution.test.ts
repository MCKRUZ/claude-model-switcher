import { describe, it, expect } from 'vitest';
import { resolvePaths } from '../../src/config/paths.js';

describe('cross-OS config resolution', () => {
  it('resolves config path ending with ccmux on current platform', () => {
    const paths = resolvePaths();
    expect(paths.configDir).toMatch(/ccmux$/);
    expect(paths.configFile).toMatch(/config\.yaml$/);
  });

  it('respects CCMUX_HOME override', () => {
    const paths = resolvePaths({ ...process.env, CCMUX_HOME: '/custom/ccmux' });
    expect(paths.configDir).toBe('/custom/ccmux');
  });

  it('uses XDG_CONFIG_HOME when set', () => {
    const env = { ...process.env, CCMUX_HOME: '', XDG_CONFIG_HOME: '/xdg/config' };
    const paths = resolvePaths(env, 'linux');
    expect(paths.configDir).toMatch(/ccmux$/);
    expect(paths.configDir).toContain('xdg');
  });

  it('uses APPDATA on win32', () => {
    const env = { ...process.env, CCMUX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' };
    const paths = resolvePaths(env, 'win32');
    expect(paths.configDir).toMatch(/ccmux$/);
    expect(paths.configDir).toContain('AppData');
  });

  it('falls back to ~/.config/ccmux', () => {
    const env = { ...process.env, CCMUX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '' };
    const paths = resolvePaths(env, 'linux');
    expect(paths.configDir).toMatch(/ccmux$/);
    expect(paths.configDir).toContain('.config');
  });
});
