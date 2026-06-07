import { useRef } from "react";
import type { ConnectionStatus, UnreadData, WSMessage } from "../types";

const EMPTY_UNREAD: UnreadData = {};
const noopSend = (_m: WSMessage) => {};
const noopSub = (_h: (m: WSMessage) => void) => () => {};
const noopReconnect = () => {};

/** Stub of useWebSocket for the landing demo: always "connected", no real
    socket. Returns STABLE references (one object per hook instance) so the
    app's effects that depend on sendWS/onMessage/unreadData don't loop. */
export function useWebSocket() {
  const ref = useRef({
    status: "connected" as ConnectionStatus,
    unreadData: EMPTY_UNREAD,
    sendWS: noopSend,
    onMessage: noopSub,
    reconnect: noopReconnect,
  });
  return ref.current;
}
export default useWebSocket;
