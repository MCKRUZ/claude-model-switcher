// Standalone binary builder: pkg (default) with bun-compile fallback.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type BuildTarget = `${'linux' | 'macos' | 'win'}-${'x64' | 'arm64'}`;

export interface BuildOptions {
  readonly target: BuildTarget;
  readonly useBun?: boolean;
  readonly outDir: string;
}

export const ALL_TARGETS: readonly BuildTarget[] = [
  'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'win-x64',
];

export type ExecFn = (
  cmd: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(err);
      }
      resolve({ exitCode: err?.code && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });

function pkgTarget(target: BuildTarget): string {
  const [os, arch] = target.split('-');
  const pkgOs = os === 'macos' ? 'macos' : os === 'win' ? 'win' : 'linux';
  return `node20-${pkgOs}-${arch}`;
}

function bunTarget(target: BuildTarget): string {
  const [os, arch] = target.split('-');
  const bunOs = os === 'macos' ? 'darwin' : os;
  return `bun-${bunOs}-${arch}`;
}

export function outputPath(outDir: string, target: BuildTarget): string {
  const suffix = target.startsWith('win') ? '.exe' : '';
  return join(outDir, target, `ccmux-${target}${suffix}`);
}

export async function buildBinary(opts: BuildOptions, exec: ExecFn = defaultExec): Promise<{ path: string }> {
  const out = outputPath(opts.outDir, opts.target);
  await mkdir(join(opts.outDir, opts.target), { recursive: true });

  if (opts.useBun) {
    await runBun(opts.target, out, exec);
    return { path: out };
  }

  const pkgResult = await runPkg(opts.target, out, exec);
  if (pkgResult.exitCode !== 0) {
    console.warn(`pkg failed for ${opts.target}, falling back to bun: ${pkgResult.stderr}`);
    await runBun(opts.target, out, exec);
  }

  return { path: out };
}

async function runPkg(target: BuildTarget, out: string, exec: ExecFn) {
  return exec('npx', [
    'pkg', 'dist/cjs/index.cjs',
    '--target', pkgTarget(target),
    '--output', out,
  ]);
}

async function runBun(target: BuildTarget, out: string, exec: ExecFn) {
  const result = await exec('bun', [
    'build', '--compile',
    '--target', bunTarget(target),
    '--outfile', out,
    'dist/cjs/index.cjs',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`bun build failed for ${target}: ${result.stderr}`);
  }
}

export function parseCliArgs(argv: readonly string[]): BuildOptions {
  let target: BuildTarget | undefined;
  let useBun = false;
  let outDir = 'dist/binaries';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) {
      target = argv[++i] as BuildTarget;
    } else if (argv[i] === '--bun') {
      useBun = true;
    } else if (argv[i] === '--out-dir' && argv[i + 1]) {
      outDir = argv[++i]!;
    }
  }

  if (!target) throw new Error('--target is required');
  if (!ALL_TARGETS.includes(target)) throw new Error(`Invalid target: ${target}`);

  return { target, useBun, outDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseCliArgs(process.argv.slice(2));
  buildBinary(opts)
    .then(r => console.log(`Built: ${r.path}`))
    .catch(err => { console.error(String(err)); process.exit(1); });
}
