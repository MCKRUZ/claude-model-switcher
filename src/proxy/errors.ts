// Synthetic SSE error emitter. The only permitted synthetic SSE output in ccmux.
import type { Writable } from 'node:stream';
import type { Logger } from 'pino';

const ERROR_BODY =
  'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed"}}\n\n';

export function emitSseError(socket: Writable, cause: unknown, logger: Logger): void {
  logger.error({ causeKind: sanitizeCause(cause) }, 'proxy upstream stream failed');
  try {
    if (!socket.writableEnded) {
      socket.write(ERROR_BODY);
      socket.end();
    }
  } catch (_err: unknown) {
    // Socket may already be destroyed; nothing recoverable.
  }
}

function sanitizeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  if (typeof cause === 'string') return 'string';
  return typeof cause;
}
