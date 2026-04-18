// `ccmux run -- <cmd...>` handler — thin CLI wrapper around runWrapper.

import { runWrapper, type WrapperResult } from '../lifecycle/wrapper.js';

export interface RunCmdOptions {
  readonly childCmd: string;
  readonly childArgs: readonly string[];
  readonly configPath?: string;
  readonly stderr?: NodeJS.WritableStream;
}

export interface SplitArgv {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly hadSeparator: boolean;
}

export function splitOnDoubleDash(argv: readonly string[]): SplitArgv {
  const idx = argv.indexOf('--');
  if (idx === -1) {
    return { before: argv.slice(), after: [], hadSeparator: false };
  }
  return {
    before: argv.slice(0, idx),
    after: argv.slice(idx + 1),
    hadSeparator: true,
  };
}

export async function runRun(opts: RunCmdOptions): Promise<number> {
  const stderr = opts.stderr ?? process.stderr;
  if (!opts.childCmd) {
    stderr.write('ccmux run: missing child command after `--`\n');
    return 2;
  }
  try {
    const result: WrapperResult = await runWrapper({
      childCmd: opts.childCmd,
      childArgs: opts.childArgs,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    });
    return result.exitCode;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`ccmux run: ${msg}\n`);
    return 1;
  }
}
