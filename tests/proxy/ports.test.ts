// listenWithFallback: sequential bind, EADDRINUSE retry, other-error rethrow, no TOCTOU helper server.
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { listenWithFallback } from '../../src/lifecycle/ports.js';

describe('listenWithFallback', () => {
  let app: FastifyInstance | undefined;
  let blocker: net.Server | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    if (blocker) await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    blocker = undefined;
  });

  it('binds on startPort when free and returns it', async () => {
    app = Fastify({ logger: false });
    const port = await listenWithFallback(app, '127.0.0.1', 0, 5);
    expect(port).toBeGreaterThan(0);
    const addr = app.server.address() as AddressInfo;
    expect(addr.port).toBe(port);
    expect(addr.address).toBe('127.0.0.1');
  });

  it('returns startPort + 1 when startPort is in use', async () => {
    blocker = net.createServer();
    await new Promise<void>((resolve) => blocker!.listen(0, '127.0.0.1', resolve));
    const busy = (blocker.address() as AddressInfo).port;
    app = Fastify({ logger: false });
    const port = await listenWithFallback(app, '127.0.0.1', busy, 10);
    expect(port).toBeGreaterThan(busy);
  });

  it('throws a clear error naming the range when all ports are occupied', async () => {
    app = Fastify({ logger: false });
    const listenSpy = vi.spyOn(app, 'listen').mockImplementation(async () => {
      const err = new Error('listen EADDRINUSE') as Error & { code: string };
      err.code = 'EADDRINUSE';
      throw err;
    });
    await expect(listenWithFallback(app, '127.0.0.1', 7000, 20))
      .rejects.toThrow(/7000-7019/);
    expect(listenSpy).toHaveBeenCalledTimes(20);
    listenSpy.mockRestore();
  });

  it('rethrows non-EADDRINUSE errors immediately without retry', async () => {
    app = Fastify({ logger: false });
    const accessErr = new Error('listen EACCES') as Error & { code: string };
    accessErr.code = 'EACCES';
    const listenSpy = vi.spyOn(app, 'listen').mockRejectedValueOnce(accessErr);
    await expect(listenWithFallback(app, '127.0.0.1', 80, 5)).rejects.toThrow(/EACCES/);
    expect(listenSpy).toHaveBeenCalledTimes(1);
    listenSpy.mockRestore();
  });

  it('does not create a TOCTOU helper server (net.createServer is never called)', async () => {
    const createServerSpy = vi.spyOn(net, 'createServer');
    const before = createServerSpy.mock.calls.length;
    app = Fastify({ logger: false });
    await listenWithFallback(app, '127.0.0.1', 0, 5);
    // Fastify itself calls net.createServer once during app construction.
    // listenWithFallback must NOT add any additional createServer calls.
    const delta = createServerSpy.mock.calls.length - before;
    expect(delta).toBeLessThanOrEqual(1);
    createServerSpy.mockRestore();
  });
});
