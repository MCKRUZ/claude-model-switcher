// commander router. Subcommands lazy-import so `ccmux version` stays fast.

import { Command, CommanderError } from 'commander';
import { splitOnDoubleDash } from './run.js';

export interface RunOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

interface ActionBox { code: number; childArgv: readonly string[]; }

export async function run(
  argv: readonly string[],
  opts: RunOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const split = splitOnDoubleDash(argv);
  const box: ActionBox = { code: 0, childArgv: split.after };
  const program = buildProgram(box, stdout, stderr);
  try {
    await program.parseAsync([...split.before], { from: 'user' });
    return box.code;
  } catch (err: unknown) {
    return handleCommanderError(err, stderr);
  }
}

function buildProgram(
  box: ActionBox,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Command {
  const program = new Command();
  program.name('ccmux').description('Claude model switcher (ccmux)').exitOverride();
  program.configureOutput({
    writeOut: (s) => stdout.write(s),
    writeErr: (s) => stderr.write(s),
  });
  program
    .command('start')
    .description('Start the ccmux proxy (debug runner)')
    .option('--foreground', 'Block on SIGINT; do not write a PID file', false)
    .action(async (cmdOpts: { foreground?: boolean }) => {
      const { runStart } = await import('./start.js');
      box.code = await runStart({ foreground: cmdOpts.foreground === true, stdout });
    });
  program
    .command('run')
    .description('Start the proxy and run a child command against it (ccmux run -- <cmd...>)')
    .allowUnknownOption(true)
    .action(async () => {
      const { runRun } = await import('./run.js');
      const [childCmd, ...childArgs] = box.childArgv;
      box.code = await runRun({
        childCmd: childCmd ?? '',
        childArgs,
        stderr,
      });
    });
  program
    .command('status')
    .description('Report proxy status from PID file and /healthz')
    .action(async () => {
      const { runStatus } = await import('./status.js');
      box.code = await runStatus({ stdout, stderr });
    });
  program
    .command('version')
    .description('Print ccmux version')
    .action(async () => {
      const { runVersion } = await import('./version.js');
      box.code = runVersion(stdout);
    });
  return program;
}

function handleCommanderError(err: unknown, stderr: NodeJS.WritableStream): number {
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') return 0;
    if (err.code === 'commander.version') return 0;
    if (err.exitCode !== undefined) return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  stderr.write(`ccmux: ${message}\n`);
  return 1;
}
