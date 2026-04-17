// Port binding helper: try startPort, fall back on EADDRINUSE up to maxAttempts times.
import type { FastifyInstance } from 'fastify';

export interface BindResult {
  readonly port: number;
}

const BIND_HOST = '127.0.0.1';

export async function bindWithFallback(
  fastify: FastifyInstance,
  startPort: number,
  maxAttempts = 20,
): Promise<BindResult> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      await fastify.listen({ port, host: BIND_HOST });
      return { port };
    } catch (err: unknown) {
      lastError = err;
      if (!isAddressInUse(err)) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`bindWithFallback: exhausted ${maxAttempts} attempts from port ${startPort}`);
}

function isAddressInUse(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EADDRINUSE';
}
