import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import Demo from "./Demo";

/* Neutralize the network: @/lib/api and @/hooks/useWebSocket are aliased to
   mocks, but a few raw fetch()/WebSocket calls exist (ui-state, browser ws).
   Return empty JSON / a dead socket so the real app boots with mock data only. */
const realFetch = window.fetch.bind(window);
// eslint-disable-next-line react-refresh/only-export-components -- demo entry-point/bootstrap (createRoot().render); has no component exports by design, fast refresh N/A
const J = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const u =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input?.url ?? "");
  if (/(^|\/)(api|preview)(\/|$)/.test(u)) {
    // most raw endpoints the app hits without the api module are LIST endpoints
    // (terminal/sessions, etc.) and expect an array; a few expect an object.
    if (/ui-state|snapshot|kpis|settings|\/status(\b|\?|$)|healthz|whoami|capabilities/i.test(u)) return J({});
    return J([]);
  }
  if (/\/ws(\b|\?)/.test(u)) return J({});
  return realFetch(input, init);
};
// dead WebSocket stub (browser-ws etc. open sockets directly)
class DeadWS {
  readyState = 3;
  constructor(_u?: string) {}
  close() {} send() {} addEventListener() {} removeEventListener() {}
  set onopen(_: ((ev: Event) => void) | null) {} set onmessage(_: ((ev: MessageEvent) => void) | null) {} set onclose(_: ((ev: CloseEvent) => void) | null) {} set onerror(_: ((ev: Event) => void) | null) {}
}
// Intentionally-incomplete stand-in for the real WebSocket; bridge through
// `unknown` since DeadWS only implements the members the app touches.
window.WebSocket = DeadWS as unknown as typeof WebSocket;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
