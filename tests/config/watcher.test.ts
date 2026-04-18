// Config hot-reload watcher: debounce, atomic swap, invalid-YAML retention,
// teardown. Uses real timers + small debounce because chokidar uses setTimeout
// internally for awaitWriteFinish, which conflicts with vitest fake timers.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { defaultConfig } from '../../src/config/defaults.js';
import { startConfigWatcher, type WatcherHandle } from '../../src/config/watcher.js';

const DEBOUNCE_MS = 100;
const SETTLE_MS = 3000; // chokidar polling on Windows + debounce + stabilization; padded for parallel test load

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function collectingLogger(): { log: pino.Logger; entries: Array<{ level: number; msg: string; obj?: unknown }> } {
  const entries: Array<{ level: number; msg: string; obj?: unknown }> = [];
  const log = pino({ level: 'warn' }, {
    write(chunk: string): void {
      const parsed: unknown = JSON.parse(chunk);
      if (typeof parsed === 'object' && parsed !== null) {
        const rec = parsed as { level?: number; msg?: string };
        entries.push({ level: rec.level ?? 0, msg: rec.msg ?? '', obj: parsed });
      }
    },
  });
  return { log, entries };
}

describe('startConfigWatcher', { timeout: 15000 }, () => {
  let tmp: string | undefined;
  let handle: WatcherHandle | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-watcher-'));
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('swaps config after a valid edit (debounced)', async () => {
    const cfg = join(tmp!, 'config.yaml');
    writeFileSync(cfg, 'port: 9000\n', 'utf8');
    const initial = { ...defaultConfig(), port: 9000 };
    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), { debounceMs: DEBOUNCE_MS });
    handle = h;
    await h.whenReady;
    expect(store.getCurrent().port).toBe(9000);

    writeFileSync(cfg, 'port: 9100\n', 'utf8');
    await waitMs(SETTLE_MS);
    expect(store.getCurrent().port).toBe(9100);
  });

  it('keeps previous config and logs warn on invalid YAML', async () => {
    const cfg = join(tmp!, 'config.yaml');
    writeFileSync(cfg, 'port: 9000\n', 'utf8');
    const { log, entries } = collectingLogger();
    const initial = { ...defaultConfig(), port: 9000 };
    const { store, handle: h } = startConfigWatcher(cfg, initial, log, { debounceMs: DEBOUNCE_MS });
    handle = h;
    await h.whenReady;

    writeFileSync(cfg, 'port: [not-a-scalar\n', 'utf8');
    await waitMs(SETTLE_MS);
    expect(store.getCurrent().port).toBe(9000); // unchanged
    const warns = entries.filter((e) => e.level >= 40);
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('coalesces rapid writes into a single reload', async () => {
    const cfg = join(tmp!, 'config.yaml');
    writeFileSync(cfg, 'port: 9000\n', 'utf8');
    const initial = { ...defaultConfig(), port: 9000 };
    const reloadSpy = vi.fn();
    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), {
      debounceMs: DEBOUNCE_MS,
      onReload: reloadSpy,
    });
    handle = h;
    await h.whenReady;

    writeFileSync(cfg, 'port: 9100\n', 'utf8');
    writeFileSync(cfg, 'port: 9200\n', 'utf8');
    writeFileSync(cfg, 'port: 9300\n', 'utf8');
    await waitMs(SETTLE_MS);
    expect(store.getCurrent().port).toBe(9300);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('atomic swap: a reference captured before reload still reads the old config', async () => {
    const cfg = join(tmp!, 'config.yaml');
    writeFileSync(cfg, 'port: 9000\n', 'utf8');
    const initial = { ...defaultConfig(), port: 9000 };
    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), { debounceMs: DEBOUNCE_MS });
    handle = h;
    await h.whenReady;

    const snapshotBefore = store.getCurrent(); // handler-style capture
    writeFileSync(cfg, 'port: 9100\n', 'utf8');
    await waitMs(SETTLE_MS);
    expect(store.getCurrent().port).toBe(9100);
    expect(snapshotBefore.port).toBe(9000); // captured reference unchanged
  });

  it('teardown: after stop(), further edits do not reload', async () => {
    const cfg = join(tmp!, 'config.yaml');
    writeFileSync(cfg, 'port: 9000\n', 'utf8');
    const initial = { ...defaultConfig(), port: 9000 };
    const reloadSpy = vi.fn();
    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), {
      debounceMs: DEBOUNCE_MS,
      onReload: reloadSpy,
    });
    await h.stop();

    writeFileSync(cfg, 'port: 9100\n', 'utf8');
    await waitMs(SETTLE_MS);
    expect(store.getCurrent().port).toBe(9000);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('missing file at start does not throw and remains idle until it appears', async () => {
    const cfg = join(tmp!, 'does-not-exist.yaml');
    const initial = { ...defaultConfig(), port: 9000 };
    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), { debounceMs: DEBOUNCE_MS });
    handle = h;
    await h.whenReady;
    expect(store.getCurrent().port).toBe(9000);
    // Give polling a cycle to settle on the missing path before creating it.
    await waitMs(150);
    writeFileSync(cfg, 'port: 9400\n', 'utf8');
    await waitMs(SETTLE_MS * 2);
    expect(store.getCurrent().port).toBe(9400);
  });
});
