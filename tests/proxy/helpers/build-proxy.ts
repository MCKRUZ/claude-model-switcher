// Helper to construct a proxy instance wired to a local upstream mock.
import type { FastifyInstance } from 'fastify';
import { AddressInfo } from 'node:net';
import { createLogger } from '../../../src/logging/logger.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { CcmuxConfig } from '../../../src/config/schema.js';
import type { ConfigStore } from '../../../src/config/watcher.js';
import type { DecisionLogWriter } from '../../../src/decisions/log.js';
import { createProxyServer, type ProxyServerOptions } from '../../../src/proxy/server.js';
import { resetUpstreamAgent } from '../../../src/proxy/upstream.js';

export interface BuiltProxy {
  app: FastifyInstance;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface BuildOpts {
  upstreamOrigin: string;
  configOverrides?: Partial<CcmuxConfig>;
  requireProxyToken?: boolean;
  proxyToken?: string;
  bodyLimit?: number;
  logLevel?: 'silent' | 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** With a config store the hot path routes and logs decisions; without, it is a plain passthrough. */
  configStore?: ConfigStore;
  decisionWriter?: DecisionLogWriter;
}

export async function buildProxy(opts: BuildOpts): Promise<BuiltProxy> {
  process.env.UPSTREAM_ORIGIN = opts.upstreamOrigin;
  const logger = createLogger({ destination: 'stderr', level: opts.logLevel ?? 'silent' });
  const base = defaultConfig();
  const config: CcmuxConfig = { ...base, ...(opts.configOverrides ?? {}) };
  const serverOpts: ProxyServerOptions = {
    port: 0,
    logger,
    config,
    requireProxyToken: opts.requireProxyToken ?? false,
  };
  if (opts.proxyToken !== undefined) {
    (serverOpts as { proxyToken?: string }).proxyToken = opts.proxyToken;
  }
  if (opts.bodyLimit !== undefined) {
    (serverOpts as { bodyLimit?: number }).bodyLimit = opts.bodyLimit;
  }
  if (opts.configStore !== undefined) {
    (serverOpts as { configStore?: ConfigStore }).configStore = opts.configStore;
  }
  if (opts.decisionWriter !== undefined) {
    (serverOpts as { decisionWriter?: DecisionLogWriter }).decisionWriter = opts.decisionWriter;
  }
  const app = await createProxyServer(serverOpts);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await resetUpstreamAgent();
      await app.close();
      delete process.env.UPSTREAM_ORIGIN;
    },
  };
}
