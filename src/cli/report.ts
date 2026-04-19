// `ccmux report`: aggregate the decision log and render a summary.
// Flags: --since <duration>, --group-by <model|project>, --format <ascii|json>.
// Exit codes: 0 on success; 1 on missing/unreadable log dir; 2 on flag errors.

import { resolvePaths } from '../config/paths.js';
import { parseDuration } from '../report/duration.js';
import { aggregate, type GroupBy, type ReportOptions } from '../report/aggregate.js';
import { renderAscii, renderJson } from '../report/tables.js';
import { fail, ok, type Result } from '../types/result.js';

export interface RunReportOpts {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly logDir?: string;
  readonly now?: number;
}

interface Flags {
  since: string;
  groupBy: string;
  format: string;
}

export async function runReport(
  argv: readonly string[],
  opts: RunReportOpts = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    stderr.write(`ccmux report: ${parsed.error}\n`);
    return 2;
  }
  const flags = parsed.value;

  const durationResult = parseDuration(flags.since);
  if (!durationResult.ok) {
    stderr.write(`ccmux report: invalid --since duration: ${flags.since}\n`);
    return 2;
  }

  if (flags.groupBy !== 'model' && flags.groupBy !== 'project') {
    stderr.write(`ccmux report: invalid --group-by (must be 'model' or 'project')\n`);
    return 2;
  }
  if (flags.format !== 'ascii' && flags.format !== 'json') {
    stderr.write(`ccmux report: invalid --format (must be 'ascii' or 'json')\n`);
    return 2;
  }

  const logDir = opts.logDir ?? resolvePaths().decisionLogDir;
  const reportOpts: ReportOptions = {
    since: durationResult.value,
    groupBy: flags.groupBy as GroupBy,
    logDir,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };

  const result = await aggregate(reportOpts);
  if (!result.ok) {
    stderr.write(`ccmux report: ${result.error}\n`);
    return 1;
  }

  if (flags.format === 'json') {
    stdout.write(renderJson(result.value) + '\n');
  } else {
    stdout.write(renderAscii(result.value));
  }
  return 0;
}

function parseFlags(argv: readonly string[]): Result<Flags, string> {
  const out: Flags = { since: '7d', groupBy: 'model', format: 'ascii' };
  const assign = (key: keyof Flags, value: string | undefined): Result<null, string> => {
    if (value === undefined || value.length === 0) {
      return fail(`missing value for --${key}`);
    }
    out[key] = value;
    return ok(null);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) break;
    let r: Result<null, string> | null = null;
    if (a === '--since') r = assign('since', argv[++i]);
    else if (a.startsWith('--since=')) r = assign('since', a.slice('--since='.length));
    else if (a === '--group-by') r = assign('groupBy', argv[++i]);
    else if (a.startsWith('--group-by=')) r = assign('groupBy', a.slice('--group-by='.length));
    else if (a === '--format') r = assign('format', argv[++i]);
    else if (a.startsWith('--format=')) r = assign('format', a.slice('--format='.length));
    else return fail(`unknown argument: ${a}`);
    if (r !== null && !r.ok) return fail(r.error);
  }
  return ok(out);
}
