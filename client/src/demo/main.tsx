import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import Demo from "./Demo";

/* Neutralize the network: @/lib/api and @/hooks/useWebSocket are aliased to
   mocks, but a few raw fetch()/WebSocket calls exist (ui-state, browser ws).
   Return empty JSON / a dead socket so the real app boots with mock data only. */
const realFetch = window.fetch.bind(window);
const J = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: any, init?: any) => {
  const u = typeof input === "string" ? input : (input?.url ?? "");
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
  set onopen(_: any) {} set onmessage(_: any) {} set onclose(_: any) {} set onerror(_: any) {}
}
(window as any).WebSocket = DeadWS;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
