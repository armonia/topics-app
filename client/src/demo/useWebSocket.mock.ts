import { useRef } from "react";

/** Stub of the real useWebSocket hook for the landing demo: always "connected",
    no real socket, no-op send, no-op subscriptions. */
export function useWebSocket() {
  const subs = useRef<Set<(m: any) => void>>(new Set());
  return {
    status: "connected" as const,
    unreadData: {} as Record<string, any>,
    sendWS: (_m: any) => {},
    onMessage: (h: (m: any) => void) => { subs.current.add(h); return () => { subs.current.delete(h); }; },
    reconnect: () => {},
  };
}
export default useWebSocket;
