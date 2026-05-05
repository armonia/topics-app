/**
 * Phase 30 BROWSER-CHAT-02 — client-side type definition for the WS message
 * envelope. KEEP IN SYNC with `server/browser-ws-messages.ts` (the canonical
 * source on the server side).
 *
 * Why a duplicate instead of a re-export from `../../../server/...`?
 * The client `tsconfig.app.json` is a `composite` project rooted at `src/`.
 * TypeScript enforces TS6307 ("file not listed within project") on any
 * `import type` that crosses the `include` boundary. Vite resolves the path
 * at build time, but `tsc --noEmit` (the strict gate this plan signs off on)
 * refuses to compile.
 *
 * Type-only file: no runtime code crosses into the client bundle, so the
 * "single source of truth" goal of `server/browser-ws-messages.ts` is
 * preserved at the protocol level — both sides serialize/deserialize the
 * same JSON envelope. Adding a new variant means editing both files; the
 * comment block above each variant flags this.
 */
export type BrowserWsMessage =
  // server -> client (base64 JPEG payload from CDP screencastFrame.data)
  | {
      type: 'frame';
      data: string;
      metadata: {
        timestamp: number;
        pageScaleFactor?: number;
        deviceWidth?: number;
        deviceHeight?: number;
      };
    }
  // client -> server (forwarded to BrowserService.dispatchInput)
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
  // both directions (request from either side, response broadcast)
  | { type: 'nav'; url: string; phase: 'request' | 'response' }
  // server -> client (lock state — UI overlay rendered in RemoteBrowserPanel since plan 30-04)
  | { type: 'agent_active'; active: boolean }
  // server -> client (forwarded console messages from the page)
  | { type: 'console'; level: 'log' | 'warn' | 'error'; text: string }
  // client -> server (Phase 30 BROWSER-CHAT-04): user reclaimed control.
  // Server triggers eager agent_active=false broadcast.
  | { type: 'take_control' };
