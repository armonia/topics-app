/**
 * `open_browser_pane` called while a native pane is still registering (card
 * f811bdae).
 *
 * On 25/09 the tool was called 60 ms after a native pane's socket reopened,
 * before the server had handled its `register_native_executor`. The route
 * counted the open socket as an attached pane and navigated at once, the
 * dispatcher found no executor for the context and drove a headless one: on a
 * machine with no Chromium the answer was `500 launch: Failed to launch
 * chromium`, and the pane stayed on its old page.
 *
 * Everything on that path is the real one except the headless browser: the
 * pane's executor socket (`startNativeExecutorSocket`), the upgrade that stamps
 * its server side, the delegation handler and the process registry the
 * dispatcher forks on, the flow, and `paneAttachedTo` built the way server.ts
 * builds it (browser-viewer-count.test.ts pins that line).
 *
 * @covers BROWSER-CHAT-04
 */
import { test, expect } from "bun:test";
import type { Server } from "bun";
import { makeOpenPaneFlow } from "./browser-open-pane-flow";
import { hasAttachedPane } from "../browser-viewer-count";
import { handleNativeDelegationFrame, nativeDelegateRegistry } from "../browser-native-delegate";
import { upgradeWebSocket } from "../lib/ws-upgrade";
import type { BrowserService } from "../browser-service";
import type { WSData } from "../types";
import { startNativeExecutorSocket } from "../../client/src/hooks/nativeExecutorSocket";

const CTX = "ctx-registering";
const URL_OPENED = "https://example.com/opened-while-registering";
/** How late the register frame lands after the open: on 25/09 it was not there 60 ms in. */
const REGISTER_LATENCY_MS = 60;
/** `PANE_WAIT_MS` and `PANE_POLL_MS` of browser-bridge.ts. */
const PANE_WAIT_MS = 2_500;
const PANE_POLL_MS = 50;

/** What server.ts holds for one browser socket. */
interface ServerSide { readyState: number; data: WSData }

/**
 * A native pane, from its executor socket to the server's side of it. The
 * server side is stamped by the upgrade the request path runs, and its frames
 * go through the delegation handler server.ts calls; on 'registered' it is
 * marked the way server.ts marks it. The register frame reaches the server
 * `REGISTER_LATENCY_MS` after it is sent, every other frame at once.
 */
function nativePane(contextId: string, browserWsClients: Map<string, Set<ServerSide>>) {
  const ran: Array<{ tool: string; url?: string }> = [];
  let open = (): void => {};
  const run = startNativeExecutorSocket({
    url: `ws://127.0.0.1:3333/ws/browser/${contextId}?client=pane-a`,
    runOp: async (tool, args) => {
      const url = (args as { url?: string }).url;
      ran.push({ tool, url });
      return { result: { url, title: "The pane's page" } };
    },
    onAgentActive: () => {},
    createSocket: (url, handlers) => {
      let data: WSData | undefined;
      const server = {
        upgrade: (_req: Request, o: { data: WSData }) => { data = o.data; return true; },
      } as unknown as Pick<Server<WSData>, "upgrade">;
      upgradeWebSocket(new Request(url.replace(/^ws/, "http")), new URL(url).pathname, server, null, false);
      if (!data) throw new Error("the upgrade did not stamp the socket");
      const side: ServerSide = { readyState: 1, data };
      open = () => {
        browserWsClients.set(contextId, new Set([side]));
        handlers.onOpen();
      };
      return {
        send: (text) => {
          const frame = JSON.parse(text) as { type?: string };
          setTimeout(() => {
            const delegated = handleNativeDelegationFrame(
              frame, contextId,
              (m) => handlers.onMessage(JSON.stringify(m)),
              nativeDelegateRegistry, side, () => side.readyState === 1,
            );
            if (delegated === "registered") side.data._nativeDelegate = true;
          }, frame.type === "register_native_executor" ? REGISTER_LATENCY_MS : 0);
        },
        close: () => { side.readyState = 3; },
      };
    },
  });
  return {
    /** The socket opens: the server holds it, and the pane sends its register frame. */
    open: () => open(),
    ran,
    stop: () => { run.stop(); nativeDelegateRegistry.unregister(contextId); },
  };
}

test("a call that lands while the pane's register frame is on the wire navigates the pane, not a headless context", async () => {
  const browserWsClients = new Map<string, Set<ServerSide>>();
  // server.ts, `paneAttachedTo`.
  const paneAttachedTo = (contextId: string): boolean => hasAttachedPane(browserWsClients.get(contextId));
  const headless: string[] = [];
  const service = {
    setAgentAction: () => {},
    broadcastAgentActive: () => {},
    navigate: async (contextId: string) => {
      headless.push(contextId);
      throw new Error("launch: Failed to launch chromium because executable doesn't exist at /nonexistent/x");
    },
  } as unknown as BrowserService;
  const flow = makeOpenPaneFlow({
    json: (body, status = 200) => Response.json(body, { status }),
    broadcastToAll: () => {},
    // The router's wait (browser-bridge.ts), on its poll.
    waitForAttachedPane: async (contextId, budgetMs) => {
      const deadline = Date.now() + budgetMs;
      while (!paneAttachedTo(contextId)) {
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, PANE_POLL_MS));
      }
      return true;
    },
    paneWaitMs: PANE_WAIT_MS,
    portOwnershipWarning: async () => undefined,
  });

  const pane = nativePane(CTX, browserWsClients);
  try {
    pane.open();
    const res = await flow({ contextId: CTX, url: URL_OPENED, projectPath: null, service, announce: () => {} });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ url: URL_OPENED, visible: true });
    expect(pane.ran, "the navigation was delegated to the pane").toEqual([{ tool: "browser_open", url: URL_OPENED }]);
    expect(headless, "no headless context was driven").toEqual([]);
  } finally {
    pane.stop();
  }
});
