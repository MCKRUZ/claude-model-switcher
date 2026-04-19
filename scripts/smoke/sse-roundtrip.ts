// Smoke test: mock upstream SSE, proxy roundtrip, golden-file comparison.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SseArgs {
  readonly binaryPath: string;
  readonly goldenFile?: string;
}

export function parseArgs(argv: readonly string[]): SseArgs {
  const positional = argv.slice(2);
  if (positional.length === 0) throw new Error('Usage: sse-roundtrip.ts <binary-path> [--golden <file>]');

  let binaryPath = '';
  let goldenFile: string | undefined;

  for (let i = 0; i < positional.length; i++) {
    if (positional[i] === '--golden' && positional[i + 1]) {
      goldenFile = positional[++i];
    } else if (!binaryPath) {
      binaryPath = positional[i]!;
    }
  }

  if (!binaryPath) throw new Error('Binary path is required');
  return { binaryPath, goldenFile };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = join(__dirname, '..', '..', 'tests', 'fixtures', 'golden-sse.txt');

function startMockUpstream(goldenData: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.end(goldenData);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function run(args: SseArgs): Promise<void> {
  const goldenPath = args.goldenFile ?? DEFAULT_GOLDEN;
  let goldenData: string;
  try {
    goldenData = readFileSync(goldenPath, 'utf-8');
  } catch {
    console.log('Golden file not found, skipping SSE roundtrip smoke test');
    return;
  }

  const upstream = await startMockUpstream(goldenData);

  const child = spawn(args.binaryPath, ['start', '--foreground', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
      ANTHROPIC_API_KEY: 'test-key-smoke',
      NODE_ENV: 'test',
    },
  });

  let childOutput = '';
  child.stdout.on('data', (d: Buffer) => { childOutput += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { childOutput += d.toString(); });

  try {
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
    const portMatch = childOutput.match(/listening.*?(\d{4,5})/i) ?? childOutput.match(/:(\d{4,5})/);
    const proxyPort = portMatch ? Number(portMatch[1]) : 0;
    if (!proxyPort) throw new Error('Could not determine proxy port');

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key-smoke',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    const body = await resp.text();
    if (body.trim() !== goldenData.trim()) {
      throw new Error('SSE output does not match golden file');
    }
    console.log('SSE roundtrip matches golden file');
  } finally {
    child.kill('SIGKILL');
    upstream.server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv))
    .then(() => process.exit(0))
    .catch(err => { console.error(String(err)); process.exit(1); });
}
