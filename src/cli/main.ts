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
  registerInit(program, box, stdout, stderr);
  registerExplain(program, box, stdout, stderr);
  registerReport(program, box, stdout, stderr);
  registerTune(program, box, stdout, stderr);
  return program;
}

function registerInit(
  program: Command,
  box: ActionBox,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  program
    .command('init')
    .description('Scaffold a starter config.yaml from a recipe (frugal, balanced, opus-forward)')
    .option('--recipe <name>', 'Recipe to use', 'balanced')
    .option('--force', 'Overwrite existing config', false)
    .action(async (cmdOpts: { recipe: string; force: boolean }) => {
      const { runInit } = await import('./init.js');
      box.code = runInit({
        recipe: cmdOpts.recipe,
        force: cmdOpts.force,
        stdout,
        stderr,
      });
    });
}

function registerExplain(
  program: Command,
  box: ActionBox,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  program
    .command('explain')
    .description('Dry-run a request through the routing pipeline and print a diagnostic report')
    .argument('<request>', 'Path to a JSON file containing an Anthropic Messages API request body')
    .option('--config <path>', 'Override config file path')
    .option('--classifier', 'Run heuristic classifier if policy abstains', false)
    .action(async (requestPath: string, cmdOpts: { config?: string; classifier: boolean }) => {
      const { runExplain } = await import('./explain.js');
      box.code = await runExplain({
        requestPath,
        configPath: cmdOpts.config,
        classifier: cmdOpts.classifier,
        stdout,
        stderr,
      });
    });
}

function registerReport(
  program: Command,
  box: ActionBox,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  // Flags are intentionally NOT declared via `.option()` — commander would
  // consume them and runReport's argv would be empty. `allowUnknownOption`
  // lets the whole tail (`--since 7d --format json`) reach `cmd.args`.
  program
    .command('report')
    .description('Summarize the decision log (flags: --since <dur>, --group-by <model|project>, --format <ascii|json>)')
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (_cmdOpts: unknown, cmd: Command) => {
      const { runReport } = await import('./report.js');
      box.code = await runReport(cmd.args as readonly string[], { stdout, stderr });
    });
}

function registerTune(
  program: Command,
  box: ActionBox,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  // Flags intentionally not declared — same reason as report (see above).
  program
    .command('tune')
    .description('Suggest policy-rule changes (flags: --since <dur>, --log-dir <path>, --config <path>)')
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (_cmdOpts: unknown, cmd: Command) => {
      const { runTune } = await import('./tune.js');
      box.code = await runTune(cmd.args as readonly string[], { stdout, stderr });
    });
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
