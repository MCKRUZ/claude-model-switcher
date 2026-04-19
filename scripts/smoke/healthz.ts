// Smoke test: start binary, hit /healthz, SIGINT, assert clean exit.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface HealthzArgs {
  readonly binaryPath: string;
  readonly port?: number;
}

export function parseArgs(argv: readonly string[]): HealthzArgs {
  const positional = argv.slice(2);
  if (positional.length === 0) throw new Error('Usage: healthz.ts <binary-path> [--port N]');

  let binaryPath = '';
  let port: number | undefined;

  for (let i = 0; i < positional.length; i++) {
    if (positional[i] === '--port' && positional[i + 1]) {
      port = Number(positional[++i]);
    } else if (!binaryPath) {
      binaryPath = positional[i]!;
    }
  }

  if (!binaryPath) throw new Error('Binary path is required');
  return { binaryPath, port };
}

async function waitForHealthz(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/healthz`);
      if (resp.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`/healthz not ready after ${timeoutMs}ms`);
}

async function run(args: HealthzArgs): Promise<void> {
  const port = args.port ?? 0;
  const child = spawn(args.binaryPath, ['start', '--foreground', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });

  let stdout = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stdout += d.toString(); });

  try {
    // Parse port from output
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
    const portMatch = stdout.match(/listening.*?(\d{4,5})/i) ?? stdout.match(/:(\d{4,5})/);
    const actualPort = portMatch ? Number(portMatch[1]) : port;
    if (!actualPort) throw new Error('Could not determine port from binary output');

    await waitForHealthz(`http://127.0.0.1:${actualPort}`);
    console.log(`healthz OK on port ${actualPort}`);

    child.kill('SIGINT');
    const exitCode = await new Promise<number>(resolve => {
      child.on('exit', (code) => resolve(code ?? 1));
      setTimeout(() => { child.kill('SIGKILL'); resolve(137); }, 5000);
    });

    if (exitCode !== 0 && exitCode !== 130) {
      throw new Error(`Binary exited with code ${exitCode} after SIGINT`);
    }
    console.log('Clean exit after SIGINT');
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv))
    .then(() => process.exit(0))
    .catch(err => { console.error(String(err)); process.exit(1); });
}
