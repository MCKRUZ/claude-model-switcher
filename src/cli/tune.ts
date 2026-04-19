// `ccmux tune`: offline analyzer. Never writes to config.yaml. Emits a
// unified diff to stdout, status messages to stderr.
// Exit codes: 0 on a successful run (no suggestions is still success).
//             1 on IO failure (missing log dir, unreadable config).
//             2 on invalid --since.

import { readFileSync, statSync } from 'node:fs';
import { resolvePaths } from '../config/paths.js';
import { parseDuration } from '../report/duration.js';
import { analyze } from '../tune/analyze.js';
import { suggest } from '../tune/suggest.js';
import { renderDiff } from '../tune/diff.js';
import { fail, ok, type Result } from '../types/result.js';

export interface RunTuneOpts {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly now?: number;
}

interface Flags {
  since: string;
  logDir: string | null;
  configPath: string | null;
}

export async function runTune(
  argv: readonly string[],
  opts: RunTuneOpts = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    stderr.write(`ccmux tune: ${parsed.error}\n`);
    return 2;
  }
  const flags = parsed.value;

  const durationResult = parseDuration(flags.since);
  if (!durationResult.ok) {
    stderr.write(`ccmux tune: invalid --since duration: ${flags.since}\n`);
    return 2;
  }

  const paths = resolvePaths();
  const logDir = flags.logDir ?? paths.decisionLogDir;
  const configPath = flags.configPath ?? paths.configFile;

  if (!validateLogDir(logDir, stderr)) return 1;

  let yaml: string;
  try {
    yaml = readFileSync(configPath, 'utf8');
  } catch {
    stderr.write(`ccmux tune: config.yaml not readable: ${configPath}\n`);
    return 1;
  }

  const now = opts.now ?? Date.now();
  const sinceIso = new Date(now - durationResult.value).toISOString();

  const result = await analyze({ logDir, since: sinceIso });
  const suggestions = suggest(result.rules);
  if (suggestions.length === 0) {
    stderr.write('ccmux tune: no suggestions\n');
    return 0;
  }

  const diffText = renderDiff(configPath, yaml, suggestions);
  if (diffText.length === 0) {
    stderr.write('ccmux tune: no suggestions\n');
    return 0;
  }

  stdout.write(diffText);
  for (const s of suggestions) {
    stderr.write(`ccmux tune: ${s.ruleId} — ${s.rationale}\n`);
  }
  return 0;
}

function validateLogDir(logDir: string, stderr: NodeJS.WritableStream): boolean {
  try {
    const s = statSync(logDir);
    if (!s.isDirectory()) {
      stderr.write(`ccmux tune: log path is not a directory: ${logDir}\n`);
      return false;
    }
    return true;
  } catch {
    stderr.write(`ccmux tune: log directory not found: ${logDir}\n`);
    return false;
  }
}

function parseFlags(argv: readonly string[]): Result<Flags, string> {
  const out: Flags = { since: '7d', logDir: null, configPath: null };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) break;
    const pair = splitEq(a);
    const inline = pair.value;
    const next = argv[i + 1];
    const value = inline ?? next;
    if (pair.key === '--since') {
      const r = setFlag(out, 'since', value);
      if (!r.ok) return fail(r.error);
    } else if (pair.key === '--log-dir') {
      const r = setFlag(out, 'logDir', value);
      if (!r.ok) return fail(r.error);
    } else if (pair.key === '--config') {
      const r = setFlag(out, 'configPath', value);
      if (!r.ok) return fail(r.error);
    } else {
      return fail(`unknown argument: ${a}`);
    }
    i += inline !== undefined ? 1 : 2;
  }
  return ok(out);
}

function setFlag(
  out: Flags,
  key: 'since' | 'logDir' | 'configPath',
  value: string | undefined,
): Result<null, string> {
  if (value === undefined || value.length === 0) {
    return fail(`missing value for --${cliName(key)}`);
  }
  out[key] = value;
  return ok(null);
}

function cliName(key: 'since' | 'logDir' | 'configPath'): string {
  if (key === 'logDir') return 'log-dir';
  if (key === 'configPath') return 'config';
  return 'since';
}

function splitEq(a: string): { readonly key: string; readonly value: string | undefined } {
  const eq = a.indexOf('=');
  if (eq === -1) return { key: a, value: undefined };
  return { key: a.slice(0, eq), value: a.slice(eq + 1) };
}
