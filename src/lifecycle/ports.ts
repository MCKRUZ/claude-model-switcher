// Sequential port bind: try startPort, fall back on EADDRINUSE up to maxAttempts times.
// Calls `server.listen` directly — no TOCTOU helper server — per plan §6.6.

import type { FastifyInstance } from 'fastify';

export interface BindResult {
  readonly port: number;
}

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_MAX_ATTEMPTS = 20;

/**
 * Sequentially attempts `server.listen({ host, port })` starting at `startPort`.
 * On `EADDRINUSE`, increments the port and retries up to `maxAttempts` times.
 * Any other error is rethrown immediately without retry.
 *
 * Returns the port actually bound (read from `server.server.address()`).
 */
export async function listenWithFallback(
  server: FastifyInstance,
  host: string,
  startPort: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<number> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      await server.listen({ host, port });
      return readBoundPort(server, port);
    } catch (err: unknown) {
      lastError = err;
      if (!isAddressInUse(err)) throw err;
    }
  }
  const endPort = startPort + maxAttempts - 1;
  const range = `${startPort}-${endPort}`;
  throw lastError instanceof Error && /EADDRINUSE/i.test(lastError.message)
    ? new Error(`listenWithFallback: all ports in range ${range} are in use`)
    : new Error(`listenWithFallback: exhausted ${maxAttempts} attempts in range ${range}`);
}

/**
 * Back-compat alias for the Fastify-only signature used elsewhere in the
 * codebase; always binds on 127.0.0.1.
 */
export async function bindWithFallback(
  fastify: FastifyInstance,
  startPort: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<BindResult> {
  const port = await listenWithFallback(fastify, DEFAULT_BIND_HOST, startPort, maxAttempts);
  return { port };
}

function readBoundPort(server: FastifyInstance, fallback: number): number {
  const addr = server.server.address();
  if (addr && typeof addr === 'object') {
    return addr.port;
  }
  return fallback;
}

function isAddressInUse(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EADDRINUSE';
}
