import { useRef } from "react";

const EMPTY_UNREAD: Record<string, any> = {};
const noopSend = (_m: any) => {};
const noopSub = (_h: (m: any) => void) => () => {};
const noopReconnect = () => {};

/** Stub of useWebSocket for the landing demo: always "connected", no real
    socket. Returns STABLE references (one object per hook instance) so the
    app's effects that depend on sendWS/onMessage/unreadData don't loop. */
export function useWebSocket() {
  const ref = useRef({
    status: "connected" as const,
    unreadData: EMPTY_UNREAD,
    sendWS: noopSend,
    onMessage: noopSub,
    reconnect: noopReconnect,
  });
  return ref.current;
}
export default useWebSocket;
