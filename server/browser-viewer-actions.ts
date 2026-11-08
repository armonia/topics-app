/**
 * Two things a viewer asks of the server's Chromium, from two doors: the
 * ordinary frame handler in server.ts and the end of a viewer's wait for its
 * native host after a restart (browser-host-boot-race.ts, NATIVE-HOST-06).
 * One body for both, so the replayed frame gets the same answers, errors
 * included, as the frame it stands for.
 */
import type { BrowserService } from "./browser-service";
import { sendBrowserWsMessage } from "../shared/browser-ws-messages";

interface ViewerSocket {
  data: { _domRender?: boolean; _browserSetStream?: (active: boolean) => void };
  send: (data: string) => void;
}

export function createViewerActions(deps: {
  browser: Pick<BrowserService, "navigate" | "setDomEmit">;
  socketsOf: (contextId: string) => Iterable<{ data: { _domRender?: boolean } }> | undefined;
}) {
  return {
    /**
     * goto failures resolve with `error` (page stayed on the old URL); launch
     * failures reject below. Both must reach the pane as phase 'error': a bare
     * 'response' made every failed navigation invisible (BRW-REL-02). The goto
     * failure is not sent from here: the service tells every viewer of the
     * context, this socket included (browser-nav-flight.ts).
     */
    navigate(ws: ViewerSocket, contextId: string, url: string): void {
      deps.browser.navigate(contextId, url).then((r) => {
        if (!r.error) sendBrowserWsMessage(ws, { type: "nav", url, phase: "response" });
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? (err.message.split("\n")[0] || "Browser failed to start") : String(err);
        console.warn(`[WS][browser] navigate failed for ${contextId}:`, msg);
        try {
          sendBrowserWsMessage(ws, { type: "nav", url, phase: "error", error: msg });
        } catch { /* socket gone: nothing to surface to */ }
      });
    },

    /** Back to pixels: resume the screencast, ack, and stop DOM emission once
     *  NO viewer of this context is in DOM mode anymore. */
    toVideo(ws: ViewerSocket, contextId: string): void {
      ws.data._domRender = false;
      ws.data._browserSetStream?.(true);
      sendBrowserWsMessage(ws, { type: "render_mode", mode: "video" });
      const anyDom = [...(deps.socketsOf(contextId) ?? [])].some((w) => w.data._domRender);
      if (!anyDom) deps.browser.setDomEmit(contextId, false);
    },
  };
}
