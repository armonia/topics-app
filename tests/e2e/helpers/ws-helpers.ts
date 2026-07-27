/**
 * WebSocket mock and intercept helpers for Playwright E2E tests.
 *
 * Uses Playwright's routeWebSocket() API (available since v1.48) for
 * transparent interception or full mocking of WebSocket connections.
 *
 * IMPORTANT: routeWebSocket must be called BEFORE page.goto() to
 * intercept the initial WebSocket connection established during page load.
 *
 * CONVENTION: No waitForTimeout() usage.
 */
import type { Page, WebSocketRoute } from "@playwright/test";

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Set up WebSocket interception that passes messages through but captures them.
 * Messages flow normally between client and server while being logged.
 * Must be called before page.goto().
 */
export async function interceptWebSocket(
  page: Page,
  urlPattern: string | RegExp = /\/ws/
) {
  const messages: { direction: "client" | "server"; data: string }[] = [];
  let wsRoute: WebSocketRoute | null = null;

  await page.routeWebSocket(urlPattern, (ws) => {
    wsRoute = ws;
    const server = ws.connectToServer();

    ws.onMessage((msg) => {
      messages.push({ direction: "client", data: String(msg) });
      server.send(msg);
    });

    server.onMessage((msg) => {
      messages.push({ direction: "server", data: String(msg) });
      ws.send(msg);
    });
  });

  return {
    messages,
    /** Filter captured messages by their JSON `type` field */
    getByType(type: string) {
      return messages.filter((m) => {
        try {
          return JSON.parse(m.data).type === type;
        } catch {
          return false;
        }
      });
    },
    /** Inject a fake server-to-client message through the intercepted connection */
    send(data: WsMessage | string) {
      if (!wsRoute) throw new Error("WebSocket not connected yet");
      wsRoute.send(typeof data === "string" ? data : JSON.stringify(data));
    },
  };
}
