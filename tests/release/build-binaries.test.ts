import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  outputPath,
  buildBinary,
  ALL_TARGETS,
  parseCliArgs,
  type ExecFn,
} from '../../scripts/build-binaries.js';

describe('build-binaries', () => {
  describe('outputPath', () => {
    it('produces dist/binaries/<target>/ccmux-<target> for unix targets', () => {
      expect(outputPath('dist/binaries', 'linux-x64')).toBe(path.join('dist/binaries', 'linux-x64', 'ccmux-linux-x64'));
      expect(outputPath('dist/binaries', 'macos-arm64')).toBe(path.join('dist/binaries', 'macos-arm64', 'ccmux-macos-arm64'));
    });

    it('adds .exe suffix for windows targets', () => {
      expect(outputPath('dist/binaries', 'win-x64')).toBe(path.join('dist/binaries', 'win-x64', 'ccmux-win-x64.exe'));
    });

    it('layout is <outDir>/<target>/ccmux-<target> for all five targets', () => {
      const sep = path.sep;
      for (const target of ALL_TARGETS) {
        const p = outputPath('dist/binaries', target);
        expect(p).toContain(`dist${sep}binaries${sep}${target}${sep}ccmux-${target}`);
        if (target.startsWith('win')) {
          expect(p).toMatch(/\.exe$/);
        } else {
          expect(p).not.toMatch(/\.exe$/);
        }
      }
    });
  });

  describe('ALL_TARGETS', () => {
    it('contains exactly 5 targets', () => {
      expect(ALL_TARGETS).toHaveLength(5);
      expect(ALL_TARGETS).toEqual(
        expect.arrayContaining(['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'win-x64']),
      );
    });
  });

  describe('buildBinary', () => {
    it('invokes pkg with CJS entry by default', async () => {
      const calls: string[][] = [];
      const mockExec: ExecFn = async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      await buildBinary({ target: 'linux-x64', outDir: 'dist/binaries' }, mockExec);
      expect(calls[0]![0]).toBe('npx');
      expect(calls[0]).toContain('pkg');
      expect(calls[0]).toContain('dist/cjs/index.cjs');
    });

    it('invokes bun build --compile when useBun is true', async () => {
      const calls: string[][] = [];
      const mockExec: ExecFn = async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      await buildBinary({ target: 'linux-x64', useBun: true, outDir: 'dist/binaries' }, mockExec);
      expect(calls[0]![0]).toBe('bun');
      expect(calls[0]).toContain('--compile');
    });

    it('falls back to bun on pkg non-zero exit with warning', async () => {
      const calls: string[][] = [];
      let callCount = 0;
      const mockExec: ExecFn = async (cmd, args) => {
        calls.push([cmd, ...args]);
        callCount++;
        if (callCount === 1) return { exitCode: 1, stdout: '', stderr: 'pkg failed' };
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      await buildBinary({ target: 'linux-x64', outDir: 'dist/binaries' }, mockExec);
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toBe('npx');
      expect(calls[1]![0]).toBe('bun');
    });
  });

  describe('parseCliArgs', () => {
    it('parses --target flag', () => {
      const opts = parseCliArgs(['--target', 'linux-x64']);
      expect(opts.target).toBe('linux-x64');
    });

    it('parses --bun flag', () => {
      const opts = parseCliArgs(['--target', 'linux-x64', '--bun']);
      expect(opts.useBun).toBe(true);
    });

    it('defaults outDir to dist/binaries', () => {
      const opts = parseCliArgs(['--target', 'linux-x64']);
      expect(opts.outDir).toBe('dist/binaries');
    });

    it('throws on missing --target', () => {
      expect(() => parseCliArgs(['--bun'])).toThrow('--target is required');
    });

    it('throws on invalid target', () => {
      expect(() => parseCliArgs(['--target', 'freebsd-mips'])).toThrow('Invalid target');
    });
  });
});
