/**
 * TLS detection, CORS helpers and the API route table.
 */
import { join } from "path";
import { timingSafeEqual } from "crypto";
import { buildRouteTable } from "../route-table";
import { isDesktopShellOrigin, isLoopbackAddress } from "../lib/auth-gate";
import type { AfterBootSweeps } from "./scope";

export async function bootHttp(scope: AfterBootSweeps) {
  const { accountRouter, activityRouter, agentChannelsRouter, agentConfigRouter, agentPermissionsRouter, agentsRouter, appSettingsRouter, authRouter, billingRouter, branchesRouter, browserRouter, calendarRouter, checkpointsRouter, claudeHooksRouter, clientTraceRouter, contextPreviewRouter, contextRouter, cronRouter, dashboardRouter, e2eRouter, externalSessionsRouter, filesRouter, goalsRouter, heavySlotRouter, hubRouter, licenseRouter, liveTerminalsRouter, machinesRouter, mcpRouter, mediaRouter, memoryRouter, memoryStoresRouter, systemHealthRouter, nodesRouter, notificationsRouter, openRouter, orchestratorSessionsRouter, peopleRouter, planRouter, processesRouter, profileRouter, scheduledJobsRouter, projectsRouter, providersRouter, pushRouter, reasoningTranslationRouter, rootDir, sessionEnvironmentRouter, statusRouter, tabsRouter, topicsCheckRouter, tasksRouter, terminalRouter, topicsRouter, uiStateRouter, usageRouter, viewsRouter, voiceRouter, worktreesRouter } = scope;
  const tlsCert = join(rootDir, "certs", "fullchain.pem");

  const tlsKey = join(rootDir, "certs", "key.pem");

  const useTls = !process.env.NO_TLS && await Bun.file(tlsCert).exists() && await Bun.file(tlsKey).exists();


  // PORTING-PLAN.md Tier 1 — CORS for the Tauri desktop shell, which serves the UI
  // locally (tauri://localhost) and calls this server cross-origin for /api + /ws.
  // Provably a no-op for the existing web/Electron clients: their Origin is never a
  // tauri/desktop origin, so corsAllowOrigin() returns "" and nothing is added.
  function corsAllowOrigin(req: Request): string {
    const origin = req.headers.get("origin") || "";
    // macOS WKWebView → tauri://localhost; Windows WebView2 → http(s)://tauri.localhost
    return isDesktopShellOrigin(origin) ? origin : "";
  }

  function applyDesktopCors(req: Request, resp: Response): void {
    const origin = corsAllowOrigin(req);
    if (!origin) return;
    resp.headers.set("Access-Control-Allow-Origin", origin);
    resp.headers.set("Vary", "Origin");
  }

  function corsPreflightHeaders(req: Request, origin: string): Record<string, string> {
    // Reflect whatever headers the request wants to send: origin is already
    // gated to the desktop-shell origins, and a fixed list rots — it silently
    // blocked every PUT carrying X-Client-Id (pane/layout sync), so the desktop
    // never persisted state except via the header-less sendBeacon teardown path.
    const requested = req.headers.get("access-control-request-headers");
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": requested || "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin, Access-Control-Request-Headers",
    };
  }


  /**
   * Confronto a tempo costante fra due stringhe già validate come esadecimali di
   * lunghezza fissa. `timingSafeEqual` lancia se i buffer hanno lunghezze diverse,
   * quindi la disuguaglianza di lunghezza si tratta prima e senza chiamarlo. Usato
   * solo dal ramo `/__daemon/*`: dopo la change `lan-open-same-origin` è l'unico
   * segreto che il server confronta.
   */
  function timingSafeEqualStr(presented: string, expected: string | null | undefined): boolean {
    if (!expected) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }


  /**
   * Le opzioni del server, estratte perché servono a DUE ascoltatori.
   *
   * Il secondo è quello del tunnel, e non è una copia del primo con un numero
   * diverso: è la stessa identica macchina raggiunta da un'altra porta. Deve
   * esserlo, o le due strade divergerebbero — e quella che diverge in silenzio è
   * sempre la meno usata, cioè proprio il tunnel.
   *
   * Delegare invece di condividere non funziona, ed è stato misurato: passando le
   * richieste al primo server con `server.fetch(req)`, il gestore riceve
   * `undefined` al posto dell'istanza e `server.upgrade` esplode. In un'app che
   * vive sul WebSocket sarebbe stato metà prodotto.
   */
  /**
   * Is there a network between us and whoever is asking?
   *
   * The one question both compression paths ask, HTTP and WebSocket alike, so it
   * is written once. Deliberately NOT `isLocalTransport`: that one asks who we
   * trust, and for it the tunnel is remote even with the peer at 127.0.0.1. Here
   * the tunnel is local, because the socket on its other end belongs to
   * `relay-client.ts` on this very machine, which inflates whatever we compress
   * before passing it on. See `server/lib/compress-json.ts`.
   */
  function isRemotePeer(req: Request, srv: { requestIP(req: Request): { address: string } | null }): boolean {
    return !isLoopbackAddress(srv.requestIP(req)?.address ?? null);
  }


  // The /api/* routers in precedence order: see server/route-table.ts.
  const apiRouteTable = buildRouteTable({
    topicsRouter,
    orchestratorSessionsRouter,
    voiceRouter,
    mediaRouter,
    branchesRouter,
    projectsRouter,
    worktreesRouter,
    machinesRouter,
    nodesRouter,
    filesRouter,
    browserRouter,
    cronRouter,
    contextRouter,
    terminalRouter,
    statusRouter,
    memoryRouter,
    mcpRouter,
    sessionEnvironmentRouter,
    activityRouter,
    externalSessionsRouter,
    liveTerminalsRouter,
    checkpointsRouter,
    goalsRouter,
    openRouter,
    contextPreviewRouter,
    authRouter,
    accountRouter,
    peopleRouter,
    licenseRouter,
    billingRouter,
    dashboardRouter,
    usageRouter,
    profileRouter,
    processesRouter,
    tasksRouter,
    planRouter,
    pushRouter,
    notificationsRouter,
    clientTraceRouter,
    uiStateRouter,
    providersRouter,
    appSettingsRouter,
    reasoningTranslationRouter,
    calendarRouter,
    heavySlotRouter,
    scheduledJobsRouter,
    topicsCheckRouter,
    agentChannelsRouter,
    agentConfigRouter,
    agentPermissionsRouter,
    agentsRouter,
    memoryStoresRouter,
    systemHealthRouter,
    tabsRouter,
    viewsRouter,
    claudeHooksRouter,
    e2eRouter,
    hubRouter,
  });

  return { apiRouteTable, applyDesktopCors, corsAllowOrigin, corsPreflightHeaders, isRemotePeer, timingSafeEqualStr, tlsCert, tlsKey, useTls };
}
