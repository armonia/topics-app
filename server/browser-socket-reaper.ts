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
