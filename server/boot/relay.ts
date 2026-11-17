/**
 * The relay client and the licence switch.
 */
import { creaRelayClient } from "../services/relay-client";
import { leggiRelayConfig, leggiRelaySegreto } from "../services/relay-config";
import { creaInterruttoreLicenza, baseUrlConcesso } from "../lib/licenza";
import { clientIpOf } from "../lib/tunnel";
import type { AfterDeliveryAudit } from "./scope";

export async function bootRelay(scope: AfterDeliveryAudit) {
  const { ctx, licenzaSvc, portaTunnel, server, serverTunnel, serverTunnelHttp, useTls } = scope;
  // `requestIP` vive sull'istanza del server, che nasce dopo il contesto: si
  // aggancia qui, cosi' le rotte che devono distinguere loopback da remoto
  // (l'appaiamento) non ricevono il server intero.
  // L'indirizzo VERO di chi chiede. Attraverso il tunnel il peer e' sempre
  // loopback, quindi il tetto per-indirizzo sull'appaiamento diventerebbe un
  // tetto per l'intero Internet: tre richieste in tutto.
  // ── Il RELAY: questa macchina chiama fuori, e nessuno chiama lei.
  //
  // Spento per default. Con `TOPICS_RELAY_URL` si collega in uscita e resta in
  // ascolto di ospiti arrivati da un link; senza, non succede niente e l'app
  // locale e' identica a prima — il relay e' un di piu', mai la strada del
  // lavoro.
  //
  // Il link e' una CAPACITA' su una cosa sola: qui non si proietta nessuna
  // sessione e nessun ruolo. Chi arriva non diventa nessuno.
  //
  // ── E IL RELAY È LA COSA CHE SI PAGA ────────────────────────────────────────
  // Il confine del listino è quello di ORG-08: gratis tutto il locale e tutta la
  // rete di casa, per sempre e senza account; si paga l'essere trovati da
  // un'ALTRA rete. Quindi il cancello sta QUI e in nessun altro punto — la
  // domanda «questa installazione ha un relay?» ha già un solo lettore, e
  // `/api/auth/relay` e la POST che conia i link passano entrambe di lì. Metterne
  // una seconda copia nelle rotte vorrebbe dire due risposte alla stessa
  // domanda, che è il modo in cui un interruttore finisce per nascondere un
  // gesto senza toglierlo.
  //
  // Cade verso il locale per costruzione: senza licenza `baseUrl` è `null`, cioè
  // esattamente lo stato «relay non configurato» che l'app sa già gestire da
  // sempre, e non uno stato d'errore nuovo.
  const relayCfg = await leggiRelayConfig(process.env, ctx.STATE_DIR);

  const relay = creaRelayClient({
    baseUrl: relayCfg.baseUrl,
    // The meeting point's name, a digest of the machine's public key. It is not
    // `installationId`, which stays tied to the licence and appears in no link:
    // `shared/relay-identita.ts` says why they were once the same value and
    // could not stay so.
    relayId: relayCfg.relayId,
    segreto: await leggiRelaySegreto(ctx.STATE_DIR),
    listActiveShareRefs: () => (ctx.db.query(
      "SELECT ref FROM share_links WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 500",
    ).all(Date.now()) as Array<{ ref: string }>).map((r) => r.ref),
    // Dove si rigioca ciò che arriva dal relay. `null` — cioè
    // `TOPICS_TUNNEL_PORT` non impostata, che è il caso di default — fa rifiutare
    // in modo dichiarato: senza l'ascoltatore dedicato l'unica porta a cui
    // rigiocare sarebbe quella principale, dove ogni richiesta è LOCALE, cioè
    // proprietaria senza credenziali.
    portaTunnel: portaTunnel,
    // L'ascoltatore del tunnel spande `opzioniServer`: se il server principale
    // ha i certificati, anche quella porta parla TLS.
    tunnelTls: useTls,
    // Il certificato su loopback è AUTOFIRMATO, e `fetch` lo rifiuterebbe. Qui
    // saltare la verifica non toglie niente: il capo dall'altra parte è questo
    // stesso processo su `127.0.0.1`, il traffico non lascia il kernel, e ciò
    // contro cui la verifica protegge — qualcuno in mezzo — su loopback non
    // esiste. Sta cablato QUI, sul solo salto locale, invece che dentro il
    // proxy: una deroga scritta accanto alla ragione non diventa un'abitudine
    // che poi qualcuno ricopia dove conta.
    ...(useTls ? {
      fetchLocale: ((input: string | URL | Request, init?: RequestInit) =>
        fetch(input as never, { ...init, tls: { rejectUnauthorized: false } } as never)) as typeof fetch,
    } : {}),
    trovaLink: (ref) => {
      try {
        const r = ctx.db.query(
          "SELECT ref, key, resource_type, resource_id, expires_at, revoked_at FROM share_links WHERE ref = ?",
        ).get(ref) as Record<string, unknown> | undefined;
        if (!r) return null;
        return {
          ref: String(r.ref), key: String(r.key),
          resourceType: r.resource_type === "topic" ? "topic" : "task",
          resourceId: String(r.resource_id),
          expiresAt: Number(r.expires_at),
          revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
        };
      } catch { return null; }
    },
    serviRisorsa: async (l) => {
      // La stessa strada dei dati locali: qui non si duplica nessuna regola.
      const riga = l.resourceType === "task"
        ? ctx.db.query("SELECT id, text, status, project_id FROM tasks WHERE id = ?").get(l.resourceId)
        : ctx.db.query("SELECT id, name, updated_at FROM topics WHERE id = ?").get(l.resourceId);
      if (!riga) return { status: 404, body: { error: "non disponibile" } };
      return { status: 200, body: riga };
    },
    segnaApertura: (ref) => {
      try {
        ctx.db.query("UPDATE share_links SET opened_count = opened_count + 1, last_opened_at = ? WHERE ref = ?")
          .run(Date.now(), ref);
      } catch { /* non deve mai far fallire una consegna */ }
    },
    log: (m) => console.log(m),
  });

  ctx.relayConfig = () => ({
    baseUrl: baseUrlConcesso(relayCfg.baseUrl, licenzaSvc.stato()),
    installationId: relayCfg.installationId,
    relayId: relayCfg.relayId,
  });

  ctx.relayConnected = () => relay.collegato();


  // Si accende e si spegne da solo: la logica delle transizioni sta in
  // `creaInterruttoreLicenza`, dove è provata. Sessanta secondi sono la
  // granularità giusta per le due cose che accadono senza che nessuno chiami
  // niente — una licenza installata mentre il server è su, e una che scade.
  const interruttoreRelay = creaInterruttoreLicenza({
    disponibile: () => !!relayCfg.baseUrl,
    stato: () => licenzaSvc.stato(),
    richiesta: { tipo: "accesso_remoto" },
    avvia: () => relay.avvia(),
    ferma: () => relay.ferma(),
  });

  interruttoreRelay.riconcilia();

  const relayLicenzaTimer = setInterval(() => interruttoreRelay.riconcilia(), 60_000);


  ctx.requestIp = (req: Request) =>
    clientIpOf(req, (serverTunnel?.requestIP(req) ?? serverTunnelHttp?.requestIP(req) ?? server.requestIP(req))?.address ?? null);

  return { relayLicenzaTimer };
}
