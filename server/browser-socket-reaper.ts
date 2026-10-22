/**
 * The heartbeat's reaping of a browser socket that stopped answering pings.
 * A half-open socket may never fire `close`, so everything the close handler
 * would do for a registered host happens here too: without `hostClosed` a
 * reaped host stayed registered and its viewers waited on it forever.
 */
export function reapBrowserSocket<T>(contextId: string, socket: T, sockets: Set<T>, deps: {
  unregisterExecutor: (contextId: string, socket: T) => void;
  unregisterLiveness: (socket: T) => void;
  hostClosed: (socket: T, contextId: string) => void;
  cleanup?: () => Promise<void>;
  close: (code: number, reason: string) => void;
}): void {
  deps.unregisterExecutor(contextId, socket);
  deps.unregisterLiveness(socket);
  void deps.cleanup?.();
  sockets.delete(socket);
  deps.hostClosed(socket, contextId);
  try { deps.close(1001, "Connection timeout"); } catch { /* the half-open socket may already be gone */ }
}
