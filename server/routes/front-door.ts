/**
 * The server options both listeners are built from (the second one is the tunnel: the same machine reached by another port).
 * The request path is a list of doors, each its own module: daemon control, the public profile, the access gate, the WebSocket
 * upgrade, the files on disk, then the API routers and the SPA fallback.
 */
import { gatedRefusal } from "../lib/primary-fence";
import { dispatchRouteTable } from "../route-table";
import { WS_TRANSPORT_OPTIONS } from "../lib/websocket-options";
import { isWebSocketPath } from "../lib/auth-gate";
import { upgradeWebSocket } from "../lib/ws-upgrade";
import { VOICE_BRIDGE_PATH } from "../services/voice-call/bridge";
import { currentRouteFault, applyRouteFault } from "../lib/route-fault";
import type { WSData } from "../types";
import { createDaemonControl } from "./daemon-control";
import { createAccessGate } from "./access-gate";
import { createStaticFiles } from "./static-files";
import { createWsOpen } from "./ws-open";
import { createWsMessage } from "./ws-message";
import { createWsClose } from "./ws-close";
import type { AfterHttp } from "../boot/scope";

export function createFrontDoor(scope: AfterHttp) {
  const { PORT, apiRouteTable, applyDesktopCors, corsAllowOrigin, corsPreflightHeaders, identityByRequest, isRemotePeer, publicProfileHandler, tlsCert, tlsKey, useTls } = scope;
  const daemonControl = createDaemonControl(scope);
  const accessGate = createAccessGate(scope);
  const { serveStatic, spaFallback } = createStaticFiles(scope);
  const wsOpen = createWsOpen(scope);
  const wsMessage = createWsMessage(scope);
  const wsClose = createWsClose(scope);

  return {
    port: PORT,
    // Bind host. Default "::" dual-stack: with net.inet6.ip6.v6only=0 (macOS
    // default) it owns BOTH the IPv6 and the IPv4-mapped families on PORT, so
    // Topics occupies localhost on every resolution path — important on a DEV box
    // where a stray server could otherwise squat ::1:PORT and clients using
    // `localhost` (resolved to ::1 first) land on it ("connecting forever").
    //
    // BUT on some Bun/macOS combos a "::" bind is effectively IPv6-only, so a
    // client connecting to 127.0.0.1 (which the packaged Electron app and its
    // readiness probe deliberately use) cannot reach it → the app hangs on the
    // splash and a relaunch hits EADDRINUSE against the still-running instance.
    // The packaged launcher therefore sets SERVER_HOST="0.0.0.0" (all IPv4 incl.
    // 127.0.0.1 and the LAN address for mobile/PWA access); IPv6 ::1 is unused by
    // the app. Override via SERVER_HOST; default stays "::" so dev is unchanged.
    hostname: process.env.SERVER_HOST || "::",
    // Exclusive ownership for the singleton. With reusePort:true a SECOND Topics
    // server on the same port doesn't fail — the OS lets both bind and round-robins
    // connections between them, so a live prod server and a stray one (e.g. a
    // worktree server with an empty DB) take turns answering and the board flickers
    // full/empty. false → the second bind fails fast with EADDRINUSE. The daemon
    // lock (acquired before Bun.serve) is the primary guard; this is defense in
    // depth for any server that bypasses it via a custom TOPICS_HOME.
    reusePort: false,
    idleTimeout: 255,
    // Explicit, so a node run (card text plus thread) is never refused by an implicit default.
    maxRequestBodySize: 256 * 1024 * 1024,
    ...(useTls ? {
      tls: {
        cert: Bun.file(tlsCert),
        key: Bun.file(tlsKey),
      },
    } : {}),

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;
      const isApiRequest = pathname.startsWith("/api/");

      // Guasto SINTETICO su una rotta: e' cio' che permette di vedere ROSSO il
      // cancello sulle latenze (`bun run check:rotte`) senza barare sulla soglia.
      // Spento ovunque tranne che nel server di prova, e solo se glielo si chiede
      // (vedi `server/lib/route-fault.ts`: vuole TOPICS_E2E=1 *e* un ritardo).
      // Qui, da spento, e' il confronto con `null` di una variabile di modulo.
      const routeFault = currentRouteFault();
      if (routeFault && isApiRequest) await applyRouteFault(pathname, routeFault);

      // Only a /__daemon/ path can answer here. Awaiting for every other request would put
      // one extra tick in front of the access gate and the WebSocket upgrade.
      if (pathname.startsWith("/__daemon/")) {
        const daemon = await daemonControl(req, server, url, pathname, method);
        if (daemon) return daemon;
      }

      // ── Pagina pubblica del profilo — senza autenticazione.
      // Risponde prima del gate: l'URL e' pensato per essere condiviso con chi
      // non ha un account Topics. Raggiungibile via LAN e via relay.
      {
        const r = publicProfileHandler(pathname, method);
        if (r) return r;
      }

      // The access gate, then the fence of a server that handed the primary over (see `gatedRefusal`).
      const refused = gatedRefusal(() => accessGate(req, server, pathname, method, isApiRequest), pathname, method);
      if (refused) return refused;

      // Every transport keeps the identity already accepted by the gate. The
      // terminal and browser used to omit it, so revoking their device closed
      // chat while leaving the terminal keyboard and browser controls alive.
      if (isWebSocketPath(pathname)) {
        // A phone call is the owner's: a guest or a delegated node never opens one.
        if (pathname === VOICE_BRIDGE_PATH && identityByRequest.get(req)?.role !== "owner") {
          return new Response(JSON.stringify({ error: "voice bridge: owner only", code: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
        }
        const wsUpgrade = upgradeWebSocket(
          req, pathname, server, identityByRequest.get(req) ?? null, isRemotePeer(req, server),
        );
        if (wsUpgrade !== null) return wsUpgrade;
      }

      const served = await serveStatic(req, url, pathname, method);
      if (served) return served;

      // Desktop shell (Tauri) CORS preflight — no-op for non-desktop origins.
      if (isApiRequest && method === "OPTIONS") {
        const o = corsAllowOrigin(req);
        if (o) return new Response(null, { status: 204, headers: corsPreflightHeaders(req, o) });
      }

      // Route through handlers
      if (isApiRequest) {
        const response = await dispatchRouteTable(apiRouteTable, req, url, pathname, method);

        if (response) {
          applyDesktopCors(req, response);
          return response;
        }
        return new Response("Not Found", { status: 404 });
      }

      const spa = await spaFallback(req, pathname, method);
      if (spa) return spa;

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      ...WS_TRANSPORT_OPTIONS,
      /**
       * Negotiates permessage-deflate. It does NOT compress anything on its own:
       * measured on Bun 1.3.8 with a byte counting proxy, `ws.send(x)` still went
       * out at 44,667 B for a 44,395 B payload, and only `ws.send(x, true)`
       * brought it to 5,423 B. The option opens the door, the per send flag walks
       * through it, and who decides is `shouldCompressFrame`
       * (`server/lib/ws-compression.ts`).
       *
       * Worth opening because the first screen comes off this socket:
       * `ui-state:init` is 86,222 B and gzips to 20,872 (4.13x), `unread:init` is
       * 81,713 and gzips to 24,936 (3.28x), for about 1.5 ms of CPU in total.
       */
      ...wsOpen,
      ...wsMessage,
      ...wsClose,
    },
    // `satisfies` e non un'annotazione: tiene la tipizzazione contestuale dei
    // gestori (che senza il generico di `Bun.serve` si perde, e `req`, `ws`,
    // `message` tornano `any`) SENZA allargare il tipo del valore, che serve
    // intatto per lo spread nell'ascoltatore del tunnel.
  } satisfies Parameters<typeof Bun.serve<WSData>>[0];
}
