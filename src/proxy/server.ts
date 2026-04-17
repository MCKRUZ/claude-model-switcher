// Fastify app factory: bind 127.0.0.1, hot path, passthrough, health, token gate, H2 reject.
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { CcmuxConfig } from '../config/schema.js';
import { makeHotPathHandler } from './hot-path.js';
import { passThrough } from './pass-through.js';
import { makeHealthHandler } from './health.js';
import { checkProxyToken } from './token.js';
import { registerRejectHttp2 } from './reject-h2.js';

export interface ProxyServerOptions {
  readonly port: number;
  readonly logger: Logger;
  readonly config: CcmuxConfig;
  readonly requireProxyToken?: boolean;
  readonly proxyToken?: string;
  readonly bodyLimit?: number;
}

const DEFAULT_BODY_LIMIT = 20 * 1024 * 1024;
const ALLOWED_BIND_HOST = '127.0.0.1';

export async function createProxyServer(opts: ProxyServerOptions): Promise<FastifyInstance> {
  const bodyLimit = opts.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const app = Fastify({
    logger: opts.logger,
    bodyLimit,
    disableRequestLogging: false,
  });

  // Fastify types FastifyInstance with a default Logger generic; our pino
  // logger widens its generics, so this cast keeps the local API uniform.
  const instance = app as unknown as FastifyInstance;
  registerHostGuard(instance);
  registerContentTypeParsers(instance);
  registerErrorHandler(instance);
  registerSecurityHooks(instance, opts);
  registerRoutes(instance, opts);
  registerRejectHttp2(instance);

  return instance;
}

function registerHostGuard(app: FastifyInstance): void {
  const origListen = app.listen.bind(app);
  (app as unknown as { listen: typeof origListen }).listen = (async (arg: unknown) => {
    if (arg && typeof arg === 'object') {
      const host = (arg as { host?: string }).host;
      if (host !== undefined && host !== ALLOWED_BIND_HOST) {
        throw new Error(`proxy: refusing to bind to host "${host}"; only 127.0.0.1 allowed`);
      }
    }
    return origListen(arg as Parameters<typeof origListen>[0]);
  }) as typeof origListen;
}

function registerContentTypeParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => { done(null, body); },
  );
  app.removeContentTypeParser(['text/plain']);
  app.addContentTypeParser('*', (_req, _payload, done) => { done(null, undefined); });
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _req, reply) => {
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply.code(413).send({ error: 'payload-too-large' });
      return;
    }
    void reply.send(error);
  });
}

function registerSecurityHooks(app: FastifyInstance, opts: ProxyServerOptions): void {
  app.addHook('onRequest', async (req, reply) => {
    if (opts.requireProxyToken === true) {
      const token = opts.proxyToken ?? '';
      if (token.length === 0 || !checkProxyToken(req, token).ok) {
        await reply.code(401).send({ error: 'unauthorized' });
      }
    }
  });
}

function registerRoutes(app: FastifyInstance, opts: ProxyServerOptions): void {
  const hot = makeHotPathHandler({ logger: opts.logger });
  const through = passThrough({ logger: opts.logger });
  const health = makeHealthHandler({
    startTimeMs: Date.now(),
    version: '0.0.0',
    mode: 'passthrough',
  });
  app.post('/v1/messages', hot);
  app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'], url: '/v1/*', handler: through });
  app.get('/healthz', health);
}
