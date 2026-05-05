/**
 * Phase 30 BROWSER-CHAT-02 — discriminated union for the /ws/browser/:contextId
 * bidirectional protocol. Shared between Bun server and React client via
 * direct TypeScript import (no runtime parsing libraries).
 *
 * Direction conventions:
 *   - frame, agent_active, console:  server -> client only
 *   - input:                         client -> server only
 *   - nav:                           both directions (request from either side, response broadcast)
 */
export type BrowserWsMessage =
  | {
      type: 'frame';
      data: string;                       // base64 JPEG payload from CDP screencastFrame.data
      metadata: {
        timestamp: number;                // CDP frame timestamp (TimeSinceEpoch ms)
        pageScaleFactor?: number;         // page zoom factor (devicePixelRatio scaling)
        deviceWidth?: number;
        deviceHeight?: number;
      };
    }
  | {
      type: 'input';
      action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress';
      payload: {
        x?: number;
        y?: number;
        text?: string;
        key?: string;
        deltaX?: number;
        deltaY?: number;
        button?: 'left' | 'right' | 'middle';
      };
    }
  | { type: 'nav'; url: string; phase: 'request' | 'response' }
  | { type: 'agent_active'; active: boolean }
  | { type: 'console'; level: 'log' | 'warn' | 'error'; text: string };

export function isBrowserWsMessage(value: unknown): value is BrowserWsMessage {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'frame' || t === 'input' || t === 'nav' || t === 'agent_active' || t === 'console';
}

/** Helper: serialize a server-side message and send via Bun ServerWebSocket. */
export function sendBrowserWsMessage<T extends { send: (data: string) => void }>(
  ws: T,
  msg: BrowserWsMessage,
): void {
  ws.send(JSON.stringify(msg));
}
