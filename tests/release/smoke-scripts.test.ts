import { describe, it, expect } from 'vitest';
import { parseArgs as parseHealthzArgs } from '../../scripts/smoke/healthz.js';
import { parseArgs as parseSseArgs } from '../../scripts/smoke/sse-roundtrip.js';
import { parseArgs as parseOutboundArgs } from '../../scripts/smoke/outbound-stub.js';

describe('smoke script argument parsing', () => {
  describe('healthz', () => {
    it('parses binary path from argv', () => {
      const args = parseHealthzArgs(['node', 'healthz.ts', '/path/to/ccmux']);
      expect(args.binaryPath).toBe('/path/to/ccmux');
    });

    it('parses --port flag', () => {
      const args = parseHealthzArgs(['node', 'healthz.ts', '/path/to/ccmux', '--port', '9090']);
      expect(args.port).toBe(9090);
    });

    it('throws on missing binary path', () => {
      expect(() => parseHealthzArgs(['node', 'healthz.ts'])).toThrow();
    });
  });

  describe('sse-roundtrip', () => {
    it('parses binary path from argv', () => {
      const args = parseSseArgs(['node', 'sse-roundtrip.ts', '/path/to/ccmux']);
      expect(args.binaryPath).toBe('/path/to/ccmux');
    });

    it('accepts optional --golden flag', () => {
      const args = parseSseArgs(['node', 'sse-roundtrip.ts', '/bin', '--golden', 'fixture.txt']);
      expect(args.goldenFile).toBe('fixture.txt');
    });

    it('throws on missing binary path', () => {
      expect(() => parseSseArgs(['node', 'sse-roundtrip.ts'])).toThrow();
    });
  });

  describe('outbound-stub', () => {
    it('parses binary path from argv', () => {
      const args = parseOutboundArgs(['node', 'outbound-stub.ts', '/path/to/ccmux']);
      expect(args.binaryPath).toBe('/path/to/ccmux');
    });

    it('accepts optional --idle-ms flag', () => {
      const args = parseOutboundArgs(['node', 'outbound-stub.ts', '/bin', '--idle-ms', '3000']);
      expect(args.idleMs).toBe(3000);
    });

    it('throws on missing binary path', () => {
      expect(() => parseOutboundArgs(['node', 'outbound-stub.ts'])).toThrow();
    });
  });
});
