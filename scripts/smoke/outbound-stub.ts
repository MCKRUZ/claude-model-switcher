// Smoke test: assert zero outbound requests on cold start.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface OutboundArgs {
  readonly binaryPath: string;
  readonly idleMs?: number;
}

export function parseArgs(argv: readonly string[]): OutboundArgs {
  const positional = argv.slice(2);
  if (positional.length === 0) throw new Error('Usage: outbound-stub.ts <binary-path> [--idle-ms N]');

  let binaryPath = '';
  let idleMs: number | undefined;

  for (let i = 0; i < positional.length; i++) {
    if (positional[i] === '--idle-ms' && positional[i + 1]) {
      idleMs = Number(positional[++i]);
    } else if (!binaryPath) {
      binaryPath = positional[i]!;
    }
  }

  if (!binaryPath) throw new Error('Binary path is required');
  return { binaryPath, idleMs };
}

async function run(args: OutboundArgs): Promise<void> {
  const idleMs = args.idleMs ?? 5000;

  const child = spawn(args.binaryPath, ['start', '--foreground', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'test-key-outbound',
    },
  });

  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { output += d.toString(); });

  await new Promise<void>(resolve => setTimeout(resolve, idleMs));
  child.kill('SIGKILL');

  const forbidden = [
    /registry\.npmjs\.org/,
    /github\.com\/.*\/releases/,
    /auto[_-]?update/i,
    /telemetry/i,
    /analytics/i,
  ];

  const violations: string[] = [];
  for (const pattern of forbidden) {
    if (pattern.test(output)) {
      violations.push(`Output matched forbidden pattern: ${pattern}`);
    }
  }

  if (violations.length > 0) {
    console.error('Outbound stub violations:');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(`No forbidden outbound activity after ${idleMs}ms idle`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv))
    .then(() => process.exit(0))
    .catch(err => { console.error(String(err)); process.exit(1); });
}
