// Wire client-socket-close → upstream AbortController.
import type { FastifyRequest } from 'fastify';

export interface AbortHandle {
  readonly controller: AbortController;
  markComplete(): void;
  dispose(): void;
}

export function wireAbort(req: FastifyRequest, controller: AbortController): AbortHandle {
  let complete = false;
  const onAbort = (): void => {
    if (complete) return;
    if (controller.signal.aborted) return;
    controller.abort(new Error('client disconnected'));
  };
  const socket = req.raw.socket;
  // Watch the TCP socket, not req.raw: IncomingMessage 'close' fires after body
  // is fully read even while the response is still streaming, which would
  // spuriously abort on long streams. The socket is the authoritative signal.
  socket?.once('close', onAbort);
  req.raw.once('aborted', onAbort);
  return {
    controller,
    markComplete(): void { complete = true; },
    dispose(): void {
      socket?.off('close', onAbort);
      req.raw.off('aborted', onAbort);
    },
  };
}
