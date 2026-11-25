/**
 * Bind the listeners (main, tunnel, model proxy, external proxy).
 */
import { getAccessToken, recoverAfter401 } from "../providers/native/auth";
import { getPrimaryRole } from "../lib/primary-role";
import { createModelProxyListener, modelProxyPort } from "../services/model-proxy";
import { bootExternalProxy, externalProxyPort } from "../services/external-proxy";
import { existsSync } from "fs";
import type { Server } from "bun";
import type { WSData } from "../types";
import { topicsHome, listenWithSquatterFallback, PortTakenError } from "../services/daemon-state";
import { setLocalFileServing } from "../browser-local-file-url";
import { markViaTunnel, tunnelPort, httpTunnelPort } from "../lib/tunnel";
import { compressJson } from "../lib/compress-json";
import type { AfterFront } from "./scope";
import { late } from "./late";

export async function bootListen(scope: AfterFront) {
  const { PORT, ctx, isRemotePeer, logRequest, opzioniServer, useTls } = scope;
  /**
   * JSON responses leave compressed toward whoever is NOT local.
   *
   * The real handler is left alone: it is wrapped once, here, where every response
   * of both listeners goes through. The reasoning for the rule, and for why
   * loopback stays raw, lives in `server/lib/compress-json.ts`. In short:
   * `/api/history` for a working topic weighs 5.17 MB and 1.39 MB compressed, but
   * the 60 ms of CPU that buys only buys a second and a half when there is a
   * network in between.
   */
  function withJsonCompression(
    handler: typeof opzioniServer.fetch,
  ): typeof opzioniServer.fetch {
    return async function (this: unknown, req, srv) {
      const res = await handler.call(this as never, req, srv);
      // `undefined` means the WebSocket upgrade succeeded: there is no HTTP
      // response to compress.
      if (!res) return res;
      return compressJson(req, res, isRemotePeer(req, srv));
    } as typeof opzioniServer.fetch;
  }


  /**
   * One line per completed `/api/*` request: timestamp, status, duration.
   *
   * Before this the log had a start line for every API request (`[HTTP] -> GET
   * /x`, no time, no outcome) and a completion line ONLY for 404s: under load you
   * could not tell which route was slow or whether a request ever finished, and
   * the file was mostly the 2s viewer poll. The outcome is what a log is for, so
   * the start line is gone and the completion line is here, outside every
   * handler, where every response of both listeners passes. `logRequest`
   * (server/utils.ts, server/lib/http-log.ts) owns the format and keeps the
   * chatty routes quiet unless they fail or are slow.
   *
   * `undefined` is a WebSocket upgrade: no response, nothing to log.
   */
  function withHttpLog(
    handler: typeof opzioniServer.fetch,
  ): typeof opzioniServer.fetch {
    return async function (this: unknown, req, srv) {
      const t0 = Date.now();
      const res = await handler.call(this as never, req, srv);
      if (res) {
        const pathname = new URL(req.url).pathname;
        if (pathname.startsWith("/api/")) logRequest(req.method, pathname, res.status, t0);
      }
      return res;
    } as typeof opzioniServer.fetch;
  }


  const fetchCompresso = withHttpLog(withJsonCompression(opzioniServer.fetch));


  // ─── Bind, then ask who is there ────────────────────────────────────────────
  // The bind is the question: the kernel answers EADDRINUSE or it does not. Only
  // then does the probe run, and only a CONFIRMED foreign process moves us to an
  // ephemeral port; Topics on the other end, or an answer nobody could read,
  // stops the boot instead of opening a second universe on another port.
  // See `listenWithSquatterFallback` in server/services/daemon-state.ts.
  let server: Server<WSData>;

  try {
    const attempt = await listenWithSquatterFallback(
      PORT,
      (port) => Bun.serve<WSData>({ ...opzioniServer, port, fetch: fetchCompresso }),
    );
    server = attempt.listener;
    if (attempt.movedToEphemeral) {
      const holder = attempt.probed?.stato === "estraneo"
        ? `pid ${attempt.probed.pid ?? "?"}${attempt.probed.comando ? ` (${attempt.probed.comando})` : ""}`
        : "a foreign process";
      console.warn(
        `[Daemon] port ${PORT} is held by ${holder}: listening on ${server.port} instead. ` +
        `The state file records the real port so the desktop can find us.`
      );
    }
  } catch (err) {
    if (err instanceof PortTakenError) {
      console.error(`[Daemon] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }


  // THE REAL PORT IS THE ONE THE CHILDREN MUST USE. `PORT` in the environment is
  // what the MCP child (server/providers/claude-code.ts) and the hooks build
  // their base URL from; if we moved, that value now points at the squatter.
  // Overwrite it BEFORE anything spawns.
  process.env.PORT = String(server.port ?? PORT);


  // Da qui in poi un file locale si può MOSTRARE senza che nessuno navighi su
  // `file://`: l'agente chiede il file, la pane va su `/api/media` di questo
  // server (browser-local-file-url.ts). Cablato DOPO Bun.serve perché la porta va
  // chiesta al server — con `PORT=0` quella in configurazione non esiste, e un
  // URL con la porta sbagliata sarebbe di nuovo una pane bianca, solo più
  // difficile da capire. Il permesso non è nuovo: è quello di `/api/media`.
  // Senza una porta vera non si cabla niente: meglio il rifiuto di prima che un
  // URL con la porta sbagliata, che sarebbe di nuovo una pane bianca.
  if (typeof server.port === "number") {
    setLocalFileServing({
      isPathAllowed: (p: string) => ctx.isPathAllowed(p),
      resolveProjectPath: (p: string) => ctx.resolveProjectPath(p),
      exists: (p: string) => existsSync(p),
      // Lo schema segue `useTls`: qui il server è in TLS, e un `http://` verso
      // 3333 non risponde affatto (ERR_EMPTY_RESPONSE, cioè pane bianca).
      origin: `${useTls ? "https" : "http"}://127.0.0.1:${server.port}`,
    });
  }


  /**
   * L'ascoltatore del TUNNEL, se configurato.
   *
   * Legato a `127.0.0.1` perché il tunnel gira su questa macchina: non aggiunge
   * superficie di rete, aggiunge una PORTA con meno fiducia. Ciò che arriva qui
   * non è locale per definizione — anche se il peer è loopback — e questo chiude
   * il rovesciamento per cui un tunnel farebbe entrare Internet come proprietario.
   *
   * Il gestore è lo stesso: si marca la richiesta e si passa la palla, senza un
   * secondo percorso da tenere allineato.
   */
  const portaTunnel = tunnelPort(process.env);

  const serverTunnel = portaTunnel
    ? Bun.serve<WSData>({
        ...opzioniServer,
        port: portaTunnel,
        hostname: "127.0.0.1",
        fetch(req: Request, srv: typeof server) {
          const stale = getPrimaryRole()?.rejectStale(req);
          if (stale) return stale;
          markViaTunnel(req);
          // `.call(srv, …)`: il gestore dichiara `this: Server`, e chiamarlo come
          // metodo dell'oggetto opzioni glielo legherebbe all'oggetto sbagliato.
          // Il gestore avvolto, non quello nudo: chi entra da qui è remoto per
          // definizione, ed è proprio chi la compressione la deve avere.
          return fetchCompresso.call(srv, req, srv);
        },
      })
    : null;

  if (serverTunnel) {
    console.log(`[Tunnel] porta dedicata su 127.0.0.1:${portaTunnel} — chi entra da qui NON e' locale`);
  }


  // The PLAINTEXT twin (see `httpTunnelPort`): a proxy forwarding from an http
  // origin must speak http on the last hop too, or the server believes the
  // scheme is https and signs the session cookie `Secure`, which the browser
  // drops on that origin, so the session is never stored.
  const portaTunnelHttp = httpTunnelPort(process.env);

  const serverTunnelHttp = portaTunnelHttp
    ? Bun.serve<WSData>({
        ...opzioniServer,
        port: portaTunnelHttp,
        hostname: "127.0.0.1",
        tls: undefined,
        fetch(req: Request, srv: typeof server) {
          const stale = getPrimaryRole()?.rejectStale(req);
          if (stale) return stale;
          markViaTunnel(req);
          return fetchCompresso.call(srv, req, srv);
        },
      })
    : null;

  if (serverTunnelHttp) {
    console.log(`[Tunnel] porta in chiaro su 127.0.0.1:${portaTunnelHttp} — chi entra da qui NON e' locale`); // allow-italian: log line, same language as its TLS twin above
  }


  // The model proxy for paired nodes: a listener of its own on loopback that
  // serves only POST /v1/messages[/count_tokens] with a per-machine token. It is
  // NEVER the main port: the node's reverse ssh tunnel lands on loopback, and on
  // the main port loopback means owner.
  const portaModelProxy = modelProxyPort(process.env);

  const serverModelProxy = portaModelProxy
    ? createModelProxyListener(portaModelProxy, {
        stateDir: ctx.STATE_DIR,
        machineExists: (machineId) => ctx.machineStore.get(machineId) !== null,
        getAccessToken,
        recoverAfter401,
        rejectStale: (req) => getPrimaryRole()?.rejectStale(req) ?? null,
      })
    : null;

  if (serverModelProxy) {
    console.log(`[ModelProxy] listening on 127.0.0.1:${portaModelProxy} (Messages API only, per-machine token)`);
  }


  // The proxy for Claude Code sessions opened OUTSIDE Topics (the Claude desktop
  // app, relaunched with HTTPS_PROXY + NODE_EXTRA_CA_CERTS): their Messages calls
  // go through the account engine instead of straight to Anthropic. Off unless
  // TOPICS_EXTERNAL_PROXY_PORT is set; loopback only, on a port of its own. The
  // state file `<topics home>/external-proxy.json` (next to daemon-state.json) tells
  // `claude-account` where it is and where the CA is. The CA key lives in the Topics
  // home, never in STATE_DIR (the checkout root in production). See docs/ENV.md.
  const portaExternalProxy = externalProxyPort(process.env);
  if (portaExternalProxy) {
    // Not awaited: a port still held by the previous process is retried for a few
    // seconds, and the rest of the boot must not wait for it.
    void bootExternalProxy({
      homeDir: topicsHome(),
      port: portaExternalProxy,
      log: (event, fields) => console.log(`[ExternalProxy] ${event}${fields ? " " + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ") : ""}`),
    }).then((proxy) => {
      if (late.externalProxyStopped) { void proxy.close(); return; }
      late.externalProxy = proxy;
      console.log(`[ExternalProxy] listening on 127.0.0.1:${proxy.port} (CONNECT proxy, ${proxy.intercepting ? "api.anthropic.com terminated with the local CA" : "tunnel only, no trusted CA"})`);
    }).catch((err) => {
      // A proxy that does not start must not take the server down with it.
      console.error(`[ExternalProxy] not started: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return { portaTunnel, server, serverTunnel, serverTunnelHttp };
}
