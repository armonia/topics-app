import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import { shouldCompressFrame } from "./ws-compression";

/** One send policy for broadcasts and the initial recovery frames. */
export function sendWsFrame(
  ws: Pick<ServerWebSocket<WSData>, "data" | "send">,
  payload: string,
  type: string,
): number {
  // Match the existing broadcast policy: length is a conservative UTF-8 size
  // estimate and avoids rescanning the same payload for every subscriber.
  return ws.send(payload, shouldCompressFrame({ type, bytes: payload.length, remote: ws.data.remote === true }));
}
