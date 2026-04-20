// GET /healthz handler.
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface HealthDeps {
  readonly startTimeMs: number;
  readonly version: string;
  readonly mode: 'passthrough' | 'enforce' | 'shadow';
}

export function makeHealthHandler(deps: HealthDeps) {
  return async function healthHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const addr = req.server.server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    await reply.header('content-type', 'application/json').send({
      status: 'ok',
      version: deps.version,
      uptimeMs: Date.now() - deps.startTimeMs,
      mode: deps.mode,
      port,
    });
  };
}
