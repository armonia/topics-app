#!/usr/bin/env bun
/**
 * Il servizio di conio. Gira DA ARMONIA, non sulla macchina di chi compra.
 *
 * ── IL BUCO CHE CHIUDE ──────────────────────────────────────────────────────
 * Il webhook dell'installazione (`server/routes/billing.ts`) sa PASSARE un
 * gettone alla porta unica, ma nessuno lo fabbricava: `interpretaEvento`
 * rispondeva `no_token_in_event` e il cliente che aveva appena pagato non
 * riceveva niente. Il gettone lo si coniava a mano, dal terminale, con
 * `scripts/licenza.ts conia`. Questo processo è ciò che rende quel passaggio
 * automatico.
 *
 * ── IL GIRO, PER INTERO ─────────────────────────────────────────────────────
 *   1. il cliente paga            → Stripe emette `customer.subscription.created`
 *   2. QUESTO servizio lo riceve  → verifica la firma con il segreto di ARMONIA
 *   3. conia con la privata       → e SCRIVE il gettone in
 *                                   `metadata.license_token` dell'abbonamento
 *   4. quella scrittura fa emettere a Stripe `customer.subscription.updated`
 *   5. l'installazione del cliente riceve QUEL secondo evento, che adesso il
 *      gettone ce l'ha, e `interpretaEvento` risponde `install_token`.
 *
 * Il passo 3 è la scelta che conta: **non si inventa un canale di consegna**. Il
 * gettone viaggia dentro Stripe, cioè nell'unico tubo che dal venditore
 * all'installazione già esiste, già è firmato, già è ritentato quando cade. Un
 * secondo canale — una mail, una chiamata diretta alla macchina del cliente,
 * un'API nostra — sarebbe una seconda cosa da tenere in piedi, da autenticare e
 * da svegliare alle tre di notte.
 *
 * ── STRIPE RESTA UN CORRIERE ────────────────────────────────────────────────
 * Questo servizio non concede niente e non può. Scrive un blob firmato in un
 * campo di testo; chi lo riceve lo RIVERIFICA con la chiave pubblica
 * (`server/lib/licenza.ts`), che resta l'unica porta di ciò che è concesso. Chi
 * bucasse l'account Stripe potrebbe scrivere `license_token: "pippo"` in un
 * metadato e otterrebbe `bad_signature`, cioè il piano gratuito. La separazione
 * regge perché la privata sta qui e QUI non è dentro il prodotto spedito.
 *
 * ── NON GIRA NELL'APP DEL CLIENTE ───────────────────────────────────────────
 * Sta in `scripts/` e non in `server/`, e non è montato da nessuna rotta: il
 * server che spediamo non deve avere nemmeno il codice che chiede una chiave
 * privata, perché la prima cosa che fa chi guarda un binario è cercare cosa
 * legge. Si accende a mano, sulla macchina che ha il segreto — vedi
 * `docs/licenze-rilascio.md`.
 *
 * Uso:
 *   TOPICS_LICENSE_PRIVKEY="$(cat ~/.topics/signing/licenza-privata.key)" \
 *   CONIO_WEBHOOK_SECRET=whsec_… STRIPE_SECRET_KEY=sk_live_… \
 *     bun scripts/conio-licenze.ts [porta]
 */
import { verificaFirmaWebhook } from "../server/lib/stripe";
import { caricaPrivata, coniaGettone, leggiCaricoNonVerificato, POSTI_MAX, KID_DEFAULT } from "./conio-lib";
import type { KeyObject } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Le costanti che sono decisioni
// ─────────────────────────────────────────────────────────────────────────────

/** Quanto il gettone sopravvive alla fine del periodo pagato.
 *
 *  Non è generosità: è il tempo che serve al rinnovo per accadere. Stripe
 *  addebita allo scadere del periodo e l'evento di rinnovo arriva dopo; con
 *  scadenza esatta il cliente passerebbe qualche minuto — o qualche ora, se la
 *  carta va ritentata — sul piano gratuito pur avendo pagato. Il verso in cui si
 *  sbaglia deve essere questo: qualche giorno di servizio in più a chi ha smesso
 *  di pagare, mai un minuto in meno a chi paga. */
export const GRAZIA_MS = 3 * 86_400_000;

/** Sotto questa differenza un gettone già presente NON si riconia.
 *
 *  È lo STOP AL CICLO, ed è la riga più importante del file: scrivere il gettone
 *  nei metadati fa emettere a Stripe un `customer.subscription.updated` che
 *  torna qui. Senza un motivo per non fare niente la seconda volta, questo
 *  servizio scriverebbe per sempre, a spese di Stripe e nostre. */
export const TOLLERANZA_SCADENZA_MS = 86_400_000;

/** Gli stati in cui l'abbonamento è finito: non si conia. Non si TOGLIE niente
 *  nemmeno — la disdetta viaggia già per conto suo come `remove_license`, e il
 *  gettone in circolazione muore alla sua scadenza. */
const STATI_FINITI = new Set(["canceled", "unpaid", "incomplete_expired"]);

/** `incomplete` non c'è fra i finiti ma non è nemmeno pagato: è il checkout a
 *  metà, e coniare lì regalerebbe un anno a chi non ha completato. */
const ALIVE_STATES = new Set(["active", "trialing", "past_due"]);

// ─────────────────────────────────────────────────────────────────────────────
// La decisione. Pura: nessuna rete, nessun orologio nascosto, nessuna chiave.
// ─────────────────────────────────────────────────────────────────────────────

export type Decisione =
  | {
      tipo: "conia";
      subscriptionId: string;
      installationId: string;
      posti: number;
      /** ms epoch */
      scadenza: number;
    }
  | { tipo: "niente"; perche: ReasonNothing };

export type ReasonNothing =
  | "not_an_event"          // il corpo non è un evento di Stripe
  | "unhandled_type"        // Stripe ne manda molti più di quanti ne servano
  | "subscription_over"     // disdetto o non pagato: la disdetta viaggia da sé
  | "not_paid_yet"          // checkout a metà
  | "no_installation_id"    // non sappiamo per QUALE macchina coniare
  | "no_subscription_id"    // niente a cui riattaccare il gettone
  | "no_period_end"         // senza fine periodo non c'è scadenza da mettere
  | "bad_seats"
  | "already_minted";       // ← lo stop al ciclo

function oggetto(o: unknown): Record<string, unknown> | null {
  return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : null;
}

function stringa(o: unknown): string | null {
  return typeof o === "string" && o.trim() ? o.trim() : null;
}

/** I posti pagati stanno sulla RIGA dell'abbonamento, non sull'abbonamento:
 *  `quantity` di primo livello è un campo che Stripe ha smesso di riempire, e
 *  leggendo solo quello si venderebbero cinque posti come uno. */
function readSlots(sub: Record<string, unknown>): number | null {
  const righe = oggetto(sub.items)?.data;
  if (Array.isArray(righe)) {
    let somma = 0;
    for (const r of righe) {
      const q = oggetto(r)?.quantity;
      if (typeof q === "number" && Number.isFinite(q)) somma += Math.floor(q);
    }
    if (somma > 0) return somma;
  }
  const q = sub.quantity;
  if (typeof q === "number" && Number.isFinite(q) && q > 0) return Math.floor(q);
  return null;
}

/** La fine del periodo pagato, in ms. Stripe la dà in secondi, e sta
 *  sull'abbonamento oppure — dalle versioni recenti dell'API — sulla riga. */
function leggiFinePeriodo(sub: Record<string, unknown>): number | null {
  const diretto = sub.current_period_end;
  if (typeof diretto === "number" && Number.isFinite(diretto) && diretto > 0) return diretto * 1000;
  const righe = oggetto(sub.items)?.data;
  if (Array.isArray(righe)) {
    for (const r of righe) {
      const v = oggetto(r)?.current_period_end;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 1000;
    }
  }
  return null;
}

/**
 * Da un evento GIÀ VERIFICATO a «conia» oppure «non fare niente, e perché».
 *
 * Si guarda SOLO `customer.subscription.created|updated`. In particolare NON
 * `checkout.session.completed`: la sessione non porta né i posti né la fine del
 * periodo, quindi bisognerebbe andarli a chiedere a Stripe — una chiamata in
 * più, in un punto dove non serve, perché per un abbonamento Stripe emette
 * comunque `customer.subscription.created` subito dopo. Aspettare quell'evento
 * costa qualche secondo e toglie un modo di sbagliare.
 */
export function decidiConio(corpo: unknown, gettoneAtteso?: { kid?: string }): Decisione {
  const e = oggetto(corpo);
  if (!e) return { tipo: "niente", perche: "not_an_event" };
  const type = stringa(e.type);
  if (!type || !stringa(e.id)) return { tipo: "niente", perche: "not_an_event" };
  if (type !== "customer.subscription.created" && type !== "customer.subscription.updated") {
    return { tipo: "niente", perche: "unhandled_type" };
  }

  const sub = oggetto(oggetto(e.data)?.object);
  if (!sub) return { tipo: "niente", perche: "not_an_event" };

  const stato = stringa(sub.status);
  if (stato && STATI_FINITI.has(stato)) return { tipo: "niente", perche: "subscription_over" };
  if (!stato || !ALIVE_STATES.has(stato)) return { tipo: "niente", perche: "not_paid_yet" };

  const subscriptionId = stringa(sub.id);
  if (!subscriptionId) return { tipo: "niente", perche: "no_subscription_id" };

  const meta = oggetto(sub.metadata);
  const installationId = meta ? stringa(meta.installation_id) : null;
  // Senza questo non c'è niente da fare: un gettone si conia PER una macchina, e
  // uno senza `iid` non esiste nel formato. È anche il motivo per cui il
  // checkout copia l'identificativo in `subscription_data.metadata`.
  if (!installationId) return { tipo: "niente", perche: "no_installation_id" };

  const fine = leggiFinePeriodo(sub);
  if (fine === null) return { tipo: "niente", perche: "no_period_end" };
  const scadenza = fine + GRAZIA_MS;

  const posti = readSlots(sub);
  if (posti === null || posti < 1 || posti > POSTI_MAX) return { tipo: "niente", perche: "bad_seats" };

  // ── Lo stop al ciclo.
  // Il gettone che abbiamo appena scritto torna indietro dentro l'evento che la
  // scrittura stessa ha generato. Se copre già QUESTO periodo, per QUESTA
  // macchina, con QUESTI posti, non c'è niente da rifare: ricominciare
  // significherebbe scrivere all'infinito.
  const esistente = meta ? stringa(meta.license_token) : null;
  if (esistente) {
    const c = leggiCaricoNonVerificato(esistente);
    const expectedKid = gettoneAtteso?.kid ?? KID_DEFAULT;
    const buono = c
      && c.iid === installationId
      && c.seats === posti
      && c.exp >= scadenza - TOLLERANZA_SCADENZA_MS
      // Dopo una rotazione il gettone vecchio è ancora leggibile e ancora
      // valido, ma è firmato con la chiave che stiamo dismettendo: riconiarlo
      // adesso è l'unico momento in cui è gratis farlo.
      && (c.kid ?? KID_DEFAULT) === expectedKid;
    if (buono) return { tipo: "niente", perche: "already_minted" };
  }

  return { tipo: "conia", subscriptionId, installationId, posti, scadenza };
}

// ─────────────────────────────────────────────────────────────────────────────
// La scrittura su Stripe
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeWrite =
  | { ok: true }
  | { ok: false; codice: "upstream_error" | "unreachable" };

/**
 * Solo la firma di chiamata di `fetch`, non `typeof fetch`: quest'ultimo in Bun
 * porta anche `preconnect`, che nessun doppio di test implementa — e un mock
 * che non compila rendeva rosso `typecheck:server` senza dire nulla sul codice.
 */
export type FetchLike = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Attacca il gettone all'abbonamento.
 *
 * Si scrive SOLO `license_token`: i metadati di Stripe si fondono, quindi
 * `installation_id` resta dov'è. Mandarlo di nuovo non farebbe danno, ma
 * riscrivere un campo che non si sta cambiando è il modo in cui un giorno lo si
 * riscrive sbagliato.
 *
 * `Idempotency-Key` è l'id dell'evento: se Stripe riconsegna lo stesso evento —
 * e lo fa, quando la nostra risposta si perde — la seconda scrittura non è una
 * seconda scrittura.
 */
export async function scriviGettone(o: {
  apiBase: string;
  secretKey: string;
  subscriptionId: string;
  gettone: string;
  eventId: string;
  fetchImpl?: FetchLike;
}): Promise<OutcomeWrite> {
  const corpo = new URLSearchParams({ "metadata[license_token]": o.gettone });
  const f = o.fetchImpl ?? fetch;
  let r: Response;
  try {
    r = await f(`${o.apiBase}/v1/subscriptions/${encodeURIComponent(o.subscriptionId)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${o.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `conio:${o.eventId}`,
      },
      body: corpo.toString(),
    });
  } catch {
    return { ok: false, codice: "unreachable" };
  }
  return r.ok ? { ok: true } : { ok: false, codice: "upstream_error" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Il gestore HTTP
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfigConio {
  /** Il segreto del webhook di ARMONIA. È un altro segreto da quello che ha
   *  l'installazione del cliente: sono due endpoint diversi dello stesso
   *  account, e confonderli significa che il servizio di conio verifica con la
   *  chiave sbagliata e non conia mai. */
  webhookSecret: string | null;
  secretKey: string | null;
  apiBase: string;
  privata: KeyObject | null;
  kid: string;
}

export function leggiConfigConio(env: Record<string, string | undefined>): ConfigConio {
  const p = caricaPrivata(env.TOPICS_LICENSE_PRIVKEY);
  const pulita = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    webhookSecret: pulita(env.CONIO_WEBHOOK_SECRET),
    secretKey: pulita(env.STRIPE_SECRET_KEY),
    apiBase: pulita(env.STRIPE_API_BASE) ?? "https://api.stripe.com",
    privata: p.ok ? p.chiave : null,
    kid: pulita(env.TOPICS_LICENSE_KID) ?? KID_DEFAULT,
  };
}

/**
 * Il gestore del webhook.
 *
 * Le regole di risposta sono quelle del webhook dell'installazione, per lo
 * stesso motivo: `4xx` a ciò che non tornerà mai (Stripe smetta), `5xx` SOLO a
 * ciò che è transitorio e va ritentato, `200` a tutto il resto. Un servizio che
 * risponde male a ciò che non gli interessa si trasforma in una coda di consegne
 * fallite che nasconde quelle vere.
 *
 * Il caso «Stripe non ha accettato la scrittura» è `500` apposta: quello sì che
 * va ritentato, ed è l'unico caso in cui un cliente che ha pagato resta senza
 * gettone se ci arrendiamo.
 */
export function creaGestoreConio(deps: {
  config: () => ConfigConio;
  now?: () => number;
  fetchImpl?: FetchLike;
  log?: (riga: string) => void;
}): (req: Request) => Promise<Response> {
  const adesso = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((r: string) => console.log(r));
  const json = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

  return async function gestore(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

    let grezzo: string;
    try {
      grezzo = await req.text();
    } catch {
      return json({ ok: false, code: "unreadable_body" }, 400);
    }

    const c = deps.config();
    const firma = verificaFirmaWebhook(
      grezzo, req.headers.get("stripe-signature"), c.webhookSecret, adesso(),
    );
    if (!firma.ok) {
      // Manca il segreto = configurazione da sistemare, quindi transitoria e da
      // ritentare. Una firma che non torna non tornerà nemmeno al decimo giro.
      return json({ ok: false, code: firma.motivo }, firma.motivo === "no_secret" ? 503 : 400);
    }

    let corpo: unknown;
    try {
      corpo = JSON.parse(grezzo) as unknown;
    } catch {
      return json({ ok: false, code: "malformed_json" }, 400);
    }

    const d = decidiConio(corpo, { kid: c.kid });
    const eventId = stringa(oggetto(corpo)?.id) ?? "?";
    if (d.tipo === "niente") return json({ received: true, id: eventId, minted: false, reason: d.perche });

    // Da qui serve il segreto. Se manca, il cliente HA pagato e non riceverà
    // niente: è la cosa peggiore che può succedere in questo file, e va detta
    // forte invece di finire in un `200` silenzioso.
    if (!c.privata || !c.secretKey) {
      log(`[conio] ALLARME: ${d.installationId} ha pagato e non posso coniare (chiave o segreto Stripe assenti)`);
      return json({ ok: false, code: "not_configured" }, 503);
    }

    let gettone: string;
    try {
      gettone = coniaGettone({
        installationId: d.installationId,
        posti: d.posti,
        scadenza: d.scadenza,
        adesso: adesso(),
        chiave: c.privata,
        kid: c.kid,
      });
    } catch (err) {
      // Un carico che non si può costruire non si costruirà nemmeno al
      // prossimo tentativo: `200`, così Stripe non ci riprova per giorni, ma
      // con la riga di log che dice chi è rimasto scoperto.
      log(`[conio] carico impossibile per ${d.installationId}: ${(err as Error).message}`);
      return json({ received: true, id: eventId, minted: false, reason: "bad_payload" });
    }

    const s = await scriviGettone({
      apiBase: c.apiBase,
      secretKey: c.secretKey,
      subscriptionId: d.subscriptionId,
      gettone,
      eventId,
      fetchImpl: deps.fetchImpl,
    });
    if (!s.ok) {
      log(`[conio] scrittura fallita su ${d.subscriptionId} (${s.codice}): riproveremo alla riconsegna`);
      return json({ ok: false, code: s.codice }, 500);
    }

    // Del gettone si registrano gli estremi, MAI il gettone: una riga di log è
    // il posto meno sorvegliato in cui possa finire una licenza valida.
    log(`[conio] coniato per ${d.installationId}: ${d.posti} posti fino al ${new Date(d.scadenza).toISOString().slice(0, 10)} (sub ${d.subscriptionId})`);
    return json({ received: true, id: eventId, minted: true, seats: d.posti, exp: d.scadenza });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// L'avvio
// ─────────────────────────────────────────────────────────────────────────────

export function avvia(porta: number, env: Record<string, string | undefined> = process.env) {
  // La configurazione si rilegge a OGNI richiesta e non al boot: una variabile
  // cambiata a caldo che non ha effetto è la trappola classica.
  const gestore = creaGestoreConio({ config: () => leggiConfigConio(env) });
  const c = leggiConfigConio(env);
  const stato = [
    c.privata ? "chiave privata: c'è" : "chiave privata: MANCA",
    c.webhookSecret ? "segreto webhook: c'è" : "segreto webhook: MANCA",
    c.secretKey ? "chiave Stripe: c'è" : "chiave Stripe: MANCA",
    `kid: ${c.kid}`,
  ].join(" · ");

  const server = Bun.serve({
    port: porta,
    // Solo il loopback: davanti ci sta il tunnel che espone l'endpoint a
    // Stripe. Un servizio che ha la privata delle licenze non si mette in
    // ascolto su ogni interfaccia perché era il default.
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/health") return new Response("ok");
      if (u.pathname !== "/webhook") return new Response("not found", { status: 404 });
      return gestore(req);
    },
  });
  console.log(`[conio] in ascolto su http://127.0.0.1:${server.port}/webhook\n[conio] ${stato}`);
  return server;
}

if (import.meta.main) {
  const porta = Number(process.argv[2] ?? process.env.CONIO_PORT ?? 4444);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65_535) {
    console.error(`Porta non valida: ${process.argv[2]}`);
    process.exit(1);
  }
  avvia(porta);
}
