import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ConfigStore } from '../config/watcher.js';
import { registerRoutes } from './api.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const hostname = host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(hostname);
}

export interface DashboardServerOpts {
  readonly configStore: ConfigStore;
  readonly decisionLogDir: string;
  readonly logger: FastifyBaseLogger;
}

export function buildServer(opts: DashboardServerOpts): FastifyInstance {
  const server = Fastify({ logger: opts.logger });

  server.addHook('onRequest', async (request, reply) => {
    if (!isLoopbackHost(request.headers.host)) {
      return reply
        .code(421)
        .send({ error: 'misdirected-request', message: 'Dashboard is loopback-only' });
    }
  });

  // SPA stub — section-18 replaces this with @fastify/static
  server.get('/', async (_req, reply) => {
    return reply.code(404).send({ error: 'spa-not-built' });
  });

  registerRoutes(server, {
    configStore: opts.configStore,
    decisionLogDir: opts.decisionLogDir,
  });

  return server;
}
