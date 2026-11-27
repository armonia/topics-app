/**
 * The origin and identity gate in front of /api, /ws, /preview, /media and /uploads: who the caller is, what a guest or a
 * delegated node may reach, and the refusal that is sent back. Returns a Response to refuse, undefined to let the request on.
 */
import { readState } from "../services/daemon-state";
import { bestEffortWrite } from "../db";
import { evaluateIdentity, isIdentityExemptPath, readSessionCookie } from "../lib/device-auth";
import { isDelegatedNodeAllowedRequest, isGuestAllowedPath, isGuestAllowedMethod } from "../lib/grants";
import { hasGrant, holdsGrantOnTaskPreview, deviceP } from "../lib/grants-query";
import { resolveDelegatedCredential, resolveIdentity } from "../lib/identity";
import { isScreenAllowedRequest } from "../lib/screen-scope";
import { isNodeAllowedRequest, markNodeDevice, shouldLearnNodeDevice } from "../lib/node-scope";
import { isBillingWebhookPath } from "../routes/billing";
import { evaluateAuth, isLoopbackAddress, isOriginGatedPath, resolveAllowedOrigins } from "../lib/auth-gate";
import { isViaTunnel, isLocalTransport } from "../lib/tunnel";
import type { Server } from "bun";
import type { WSData } from "../types";
import type { AfterHttp } from "../boot/scope";

export function createAccessGate(scope: Pick<AfterHttp, "corsAllowOrigin" | "ctx" | "identityByRequest">) {
  const { corsAllowOrigin, ctx, identityByRequest } = scope;
  return function accessGate(req: Request, server: Server<WSData>, pathname: string, method: string, isApiRequest: boolean): Response | undefined {
    // ── Origin gate — guards /api, /ws, /preview, /media, /uploads.
    // Una sola decisione, e riguarda l'ORIGINE: viene bloccata una richiesta
    // MUTANTE o un upgrade WS la cui `Origin` non è lo stesso sito dell'`Host`
    // (né una origine ammessa esplicitamente). È la difesa contro un sito che
    // l'utente visita e che da lì guida questo server.
    //
    // NON c'è più un asse di TRASPORTO: nessun token, nessun controllo
    // sull'indirizzo del peer. Chi può raggiungere la porta lo decide la rete —
    // vedi `server/lib/auth-gate.ts` per il modello intero e per il perché le
    // richieste non mutanti non passano di qui (le protegge l'assenza di
    // `Access-Control-Allow-Origin` in `corsAllowOrigin`).
    //
    // Il preflight OPTIONS è esente (gli si risponde sotto). Botola di recupero:
    // TOPICS_AUTH_OFF=1 + kickstart.
    if (method !== "OPTIONS" && isOriginGatedPath(pathname)) {
      // ── Asse IDENTITA', risolto qui perche' serve il DB (il gate resta puro).
      // Le due sole esenzioni sono i percorsi che SERVONO a ottenere l'identita':
      // esentarne uno di troppo e' un buco, uno di meno un vicolo cieco in cui
      // non ci si puo' appaiare.
      const peerIp = server.requestIP(req)?.address ?? null;
      // Il webhook di Stripe non ha — e non può avere — un'identità di
      // dispositivo: arriva da un server, non da un browser appaiato. Si
      // autentica da sé, con un HMAC sul corpo ESATTO (`server/lib/stripe.ts`),
      // che è una prova più forte di un cookie. Sta scritto QUI e non dentro
      // `isIdentityExemptPath` perché quella elenca i percorsi che servono a
      // OTTENERE un'identità: mescolarci un'autenticazione di altra natura
      // renderebbe più difficile accorgersi della prossima esenzione di troppo.
      const identity = (isIdentityExemptPath(pathname, method) || isBillingWebhookPath(pathname))
        ? undefined
        : (() => {
            const loopback = isLocalTransport(req, peerIp, isLoopbackAddress);
            const delegated = loopback ? null : resolveDelegatedCredential(
              ctx.db,
              req.headers.get("cookie"),
              req.headers.get("x-topics-delegated-capability"),
            );
            // UNA sola traduzione cookie→identità, condivisa con l'upgrade del
            // WebSocket e con `/api/auth/session`. Erano tre query diverse, e
            // divergevano: la strada dimenticata è sempre la meno percorsa,
            // cioè quella dove il difetto vive di più prima che si veda.
            const io = delegated ? null : resolveIdentity(ctx.db, req.headers.get("cookie"), loopback);
            const device = io?.device ?? null;
            const sessionToken = loopback ? null : readSessionCookie(req.headers.get("cookie"));
            const r = delegated
              ? { ok: true as const, as: "delegated" as const, deviceName: null, role: "guest" as const, deviceId: null }
              : evaluateIdentity({
                  transport: loopback ? "loopback" : "remote",
                  sessionToken,
                  device,
                  bearerToken: loopback ? null : req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null,
                  expectedDaemonToken: loopback ? null : readState()?.token ?? null,
                  now: Date.now(),
                });
            // `last_seen_at` con parsimonia: sono ~94 chiamate per boot, e una
            // scrittura per ognuna trasformerebbe l'elenco dispositivi in una
            // sorgente di I/O. Un'ora di granularita' basta a dire «visto
            // l'ultima volta…».
            if (r.ok && r.as === "device" && device && (Date.now() - (device.lastSeenAt ?? 0)) > 3_600_000) {
              // Skipped under the primary switch fence (`bestEffortWrite`): the DB is read-only there and the
              // front door must still answer `primary_moved`.
              bestEffortWrite(() => { ctx.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), device.id); });
            }
            if (r.ok) {
              // I PRINCIPALI di questo dispositivo: sé stesso, la sua persona,
              // le sue organizzazioni. Da qui in poi le concessioni si
              // confrontano con TUTTI, quindi una condivisione fatta a una
              // persona o a un team ha effetto senza che nessuna riga venga
              // riscritta a ogni pairing.
              const princ = r.deviceId ? io : null;
              identityByRequest.set(req, {
                role: r.role,
                deviceId: r.deviceId,
                principal: princ ? {
                  principals: princ.principals,
                  confined: princ.confined,
                  rev: princ.rev,
                } : null,
                ...(delegated ? {
                  delegatedAuthorizationId: delegated.authorizationId,
                  delegatedCapabilityId: delegated.capabilityId,
                } : {}),
              });
              // A device paired as a SCREEN reads the load screen's data and nothing else:
              // decided before the guest rules, which would open far more than a monitor needs.
              if (io?.screen) {
                return isScreenAllowedRequest(pathname, method)
                  ? { ok: true as const }
                  : { ok: false as const, status: 403, reason: "screen device", code: "screen_scope" };
              }
              // A machine credential paired before the node scope existed is marked the first
              // time it calls the run routes as a Topics server (`shouldLearnNodeDevice`).
              if (io && !io.node && device && shouldLearnNodeDevice(pathname, req.headers.get("user-agent"))) {
                bestEffortWrite(() => markNodeDevice(ctx.db, device.id, null, "learned"));
                io.node = true;
                console.log(`[auth] device ${device.id} called the node routes as a Topics server: it is a node credential from now on`);
              }
              // The credential a server collected by pairing this node reaches the fleet's
              // routes and nothing else: no command, no topic, no pairing, no settings.
              if (io?.node) {
                return isNodeAllowedRequest(pathname, method)
                  ? { ok: true as const }
                  : { ok: false as const, status: 403, reason: "node credential", code: "node_scope" };
              }
              if (delegated && !isDelegatedNodeAllowedRequest(pathname, method)) {
                return { ok: false as const, status: 403, reason: "delegated credential scope", code: "delegated_scope" };
              }
              // ── L'OSPITE è confinato QUI, non nei singoli router.
              // Metterlo nei router significa dimenticarne uno: provato sulla
              // mia pelle mentre costruivo questo — col filtro nel solo router
              // dei task, un ospite leggeva `/api/topics` per intero.
              if (r.role === "guest") {
                if (!isGuestAllowedPath(pathname)) {
                  return { ok: false as const, status: 403, reason: "non disponibile per un ospite", code: "guest_forbidden" };
                }
                // Il METODO, che è il terzo asse e mancava. L'allowlist apre la
                // strada, il controllo sotto dice quale stanza, e questo dice
                // cosa ci si può fare: senza, `level='read'` era una parola
                // nello schema che nessuno faceva valere, e un ospite poteva
                // modificare o cancellare la scheda che gli avevi condiviso.
                if (!isGuestAllowedMethod(pathname, method)) {
                  return { ok: false as const, status: 403, reason: "sola lettura", code: "guest_read_only" };
                }
                // L'allowlist apre la STRADA; qui si controlla la STANZA. Un
                // percorso concesso con dentro l'id di una risorsa NON concessa
                // è il modo in cui un'allowlist di percorsi diventa inutile.
                if (r.deviceId) {
                  // Tutti i principali, non il solo dispositivo: è qui che
                  // «condiviso con una persona» smette di essere una riga
                  // inerte e diventa un accesso.
                  const principali = princ?.principals ?? deviceP(r.deviceId);
                  const concessa = (tipo: "task" | "topic", id: string): boolean =>
                    hasGrant(ctx.db, principali, tipo, id);

                  const idTask = pathname.match(/^\/api\/tasks\/([^/]+)/)?.[1];
                  if (idTask && !concessa("task", decodeURIComponent(idTask))) {
                    return { ok: false as const, status: 403, reason: "non condiviso", code: "not_shared" };
                  }
                  const idTopic = pathname.match(/^\/api\/(?:topics|messages)\/([^/]+)/)?.[1];
                  if (idTopic && !concessa("topic", decodeURIComponent(idTopic))) {
                    return { ok: false as const, status: 403, reason: "non condiviso", code: "not_shared" };
                  }
                  // `/media/` è aperto come percorso, non come contenuto: passa
                  // solo il file che è l'anteprima di un task concesso.
                  if (pathname.startsWith("/media/")) {
                    const richiesto = decodeURIComponent(pathname.slice("/media".length));
                    // I metacaratteri del LIKE vanno neutralizzati: un `%` in un
                    // nome di file trasformerebbe «questa anteprima» in «una
                    // qualunque anteprima», cioè in un passe-partout.
                    const ok = holdsGrantOnTaskPreview(ctx.db, principali, richiesto);
                    if (!ok) {
                      return { ok: false as const, status: 403, reason: "anteprima non condivisa", code: "guest_forbidden" };
                    }
                  }
                }
              }
              return { ok: true as const };
            }
            return { ok: false as const, status: r.status, reason: r.reason, code: r.code };
          })();

      const decision = evaluateAuth({
        origin: req.headers.get("origin"),
        method,
        pathname,
        host: req.headers.get("host"),
        authOff: process.env.TOPICS_AUTH_OFF === "1",
        allowedOrigins: resolveAllowedOrigins(),
        viaTunnel: isViaTunnel(req),
        identity,
      });
      if (!decision.allow) {
        // The REFUSED value, not just the axis. "host not allowed" without
        // saying WHICH host sends you to read the code and guess: it happened
        // on 2026-08-21 on a pairing from the phone, with an allowlist that
        // looked right in the log and a phone sending a name that was not in it.
        if (isApiRequest) {
          const dettaglio = decision.reason === "host not allowed"
            ? ` (host="${req.headers.get("host") ?? ""}")`
            : decision.reason?.includes("origin")
              ? ` (origin="${req.headers.get("origin") ?? ""}")`
              : "";
          console.log(`[HTTP] ✗ ${method} ${pathname} — ${decision.status}: ${decision.reason}${dettaglio}`);
        }
        const o = corsAllowOrigin(req);
        // Il `code` distingue «non sei appaiato» da «origine forestiera»: e' su
        // quello che il client decide se aprire la schermata di appaiamento o
        // limitarsi a segnalare. Un 401 muto era il difetto per cui il pairing
        // precedente non e' mai servito a nessuno.
        // The host axis gets its OWN code. With `forbidden` the phrase the
        // phone shows is the generic one, and the reason — the address it is
        // calling from — stays in the prose of `error`, which the interface
        // does not translate. See `shared/auth-codes.ts`.
        const codiceRifiuto = decision.code
          ?? (decision.reason === "host not allowed" ? "host_not_allowed" : "forbidden");
        return new Response(JSON.stringify({ error: decision.reason, code: codiceRifiuto }), {
          status: decision.status,
          headers: { "content-type": "application/json", ...(o ? { "Access-Control-Allow-Origin": o, Vary: "Origin" } : {}) },
        });
      }
    }
    return undefined;
  };
}
