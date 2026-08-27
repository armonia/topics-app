/**
 * L'aggancio a Stripe: il pagamento, e SOLO il pagamento.
 *
 * ── STRIPE NON CONCEDE NIENTE ───────────────────────────────────────────────
 * Questo modulo non ha una riga che dica «da adesso puoi». Cosa è concesso lo
 * decide `server/lib/licenza.ts` verificando un gettone firmato Ed25519, e
 * quella resta l'UNICA porta. Il massimo che un evento di Stripe può fare è
 * PASSARE un gettone a quella porta, che lo ricontrolla da capo: un webhook
 * contraffatto con dentro un gettone inventato produce `bad_signature`, cioè il
 * piano gratuito, esattamente come se non fosse mai arrivato.
 *
 * È la differenza fra «Stripe dice che hanno pagato» e «questa macchina può
 * fare X». Tenerle separate significa che il giorno in cui l'account Stripe
 * viene bucato, o un evento viene rigiocato, o qualcuno indovina l'URL del
 * webhook, nessuno guadagna una capacità: mancherebbe comunque la chiave
 * privata, che non sta in questo repository in nessuna forma.
 *
 * ── SENZA CHIAVE È IL CASO NORMALE, NON UN GUASTO ───────────────────────────
 * In sviluppo, nei test e su ogni installazione che non fattura niente, le
 * variabili non ci sono. Allora `configurato` è `false`, i gesti che
 * richiedono Stripe rispondono con un codice che dice perché, e NIENTE
 * solleva. Un adattatore che esplode quando manca la sua configurazione è un
 * adattatore che rende obbligatoria una cosa che avevamo deciso fosse
 * facoltativa.
 *
 * ── I SEGRETI ARRIVANO SOLO DALL'AMBIENTE ───────────────────────────────────
 * `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` si leggono da `env` e non
 * escono MAI da qui: non finiscono in una risposta, in un log, in un messaggio
 * d'errore. `statoPubblico()` esiste apposta — dice SE c'è una chiave, mai
 * quale. Nel repository non c'è, e non deve comparire, nessun valore vero.
 *
 * ── LE STRINGHE SONO IL PROTOCOLLO ──────────────────────────────────────────
 * `motivo`/`codice` sono in inglese perché escono dalla rotta e arrivano
 * all'interfaccia, che ci scrive sopra la propria frase. Un modulo di server
 * che spedisce prosa è il posto dove quella prosa resta l'unica esistente.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// La configurazione, che viene solo dall'ambiente
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfigStripe {
  /** `null` = non configurato. Non esce mai da questo processo. */
  secretKey: string | null;
  /** `null` = i webhook non si possono verificare, quindi non si accettano. */
  webhookSecret: string | null;
  /** Il listino a cui iscrivere. Senza, non si può aprire un checkout. */
  priceId: string | null;
  /** Base dell'API. Sovrascrivibile per puntare a un finto server nei test. */
  apiBase: string;
}

const API_BASE_DEFAULT = "https://api.stripe.com";

/**
 * Un valore d'ambiente «c'è davvero».
 *
 * Vuoto e soli spazi valgono assente: è il caso di una variabile dichiarata e
 * mai riempita, che altrimenti farebbe sembrare l'installazione configurata per
 * poi far fallire ogni chiamata con un errore che non nomina la causa.
 *
 * Uno spazio INTERNO invece è quasi sempre un incollaggio andato storto (una
 * chiave spezzata su due righe, un «<la tua chiave>»): si rifiuta, perché una
 * chiave storta trattata come buona diventa un errore di Stripe a valle, dove
 * nessuno lo collega più alla variabile d'ambiente.
 *
 * Non si controlla il PREFISSO (`sk_`, `whsec_`): i formati delle chiavi sono
 * di Stripe e cambiano, e un controllo di forma che invecchia rifiuterebbe una
 * chiave buona — un guasto peggiore di quello che previene.
 */
function valore(env: Record<string, string | undefined>, nome: string): string | null {
  const v = (env[nome] ?? "").trim();
  if (!v) return null;
  if (/\s/.test(v)) return null;
  return v;
}

export function leggiConfigStripe(env: Record<string, string | undefined>): ConfigStripe {
  let apiBase = API_BASE_DEFAULT;
  const grezzo = (env.STRIPE_API_BASE ?? "").trim();
  if (grezzo) {
    try {
      const u = new URL(grezzo);
      // Solo http/https: un valore storto qui diventerebbe una chiamata verso
      // un posto che non abbiamo scelto, con in testa la chiave segreta.
      if (u.protocol === "http:" || u.protocol === "https:") {
        apiBase = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
      }
    } catch { /* si resta sul default */ }
  }
  return {
    secretKey: valore(env, "STRIPE_SECRET_KEY"),
    webhookSecret: valore(env, "STRIPE_WEBHOOK_SECRET"),
    priceId: valore(env, "STRIPE_PRICE_ID"),
    apiBase,
  };
}

export interface PublicStateStripe {
  /** Si può aprire un checkout: serve la chiave E il listino. */
  configured: boolean;
  /** I webhook si possono verificare. Indipendente dal precedente: una
   *  installazione può ricevere eventi senza poter aprire un checkout. */
  webhookConfigured: boolean;
}

/**
 * Ciò che si può dire a chi guarda: due booleani, e nient'altro.
 *
 * Non c'è un ramo di questa funzione che possa restituire un frammento di
 * chiave — nemmeno gli ultimi quattro caratteri, nemmeno la sola distinzione
 * fra `sk_test` e `sk_live`. Una risposta che descrive il segreto è una
 * risposta che, il giorno in cui la rotta smette di essere protetta, lo
 * consegna.
 */
export function statoPubblico(c: ConfigStripe): PublicStateStripe {
  return {
    configured: !!c.secretKey && !!c.priceId,
    webhookConfigured: !!c.webhookSecret,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// La firma del webhook: l'unica cosa che dice che l'evento viene da Stripe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PERCHÉ un evento è stato rifiutato. Sette esiti e non «sì/no», perché
 * «non ho un segreto con cui controllare» è una configurazione da sistemare e
 * «la firma non torna» è un evento da buttare, e chi legge i log deve poterli
 * distinguere senza indovinare.
 */
export type ReasonSignature =
  | "no_secret"        // non configurato: non si accetta niente, e lo si dice
  | "missing_header"   // nessun `Stripe-Signature`
  | "malformed_header" // c'è ma non ha `t=` e almeno un `v1=`
  | "bad_timestamp"    // `t` non è un numero
  | "too_old"          // fuori tolleranza: è un rigioco
  | "bad_signature"
  | "valid";

/** Quanto indietro può essere un evento. Cinque minuti è la tolleranza di
 *  Stripe: più larga rende utile rigiocare un evento intercettato, più stretta
 *  butta eventi buoni consegnati in ritardo da una rete lenta. */
export const TOLLERANZA_MS = 300_000;

export type OutcomeSignature =
  | { ok: true }
  | { ok: false; motivo: Exclude<ReasonSignature, "valid"> };

/**
 * Il carico su cui Stripe calcola l'HMAC: `${t}.${corpo grezzo}`.
 *
 * «Corpo GREZZO» non è un dettaglio: i byte esatti che sono arrivati. Se si
 * verificasse su un oggetto ri-serializzato, due JSON con le stesse chiavi in
 * ordine diverso — o con uno spazio in più — darebbero digest diversi, e la
 * verifica fallirebbe su eventi buoni oppure, molto peggio, passerebbe su un
 * corpo che non è quello firmato. È lo stesso motivo per cui `licenza.ts` firma
 * i byte ASCII del segmento e non l'oggetto.
 */
function signedLoad(t: string, corpoGrezzo: string): string {
  return `${t}.${corpoGrezzo}`;
}

/** Confronto a tempo costante fra due digest esadecimali. La lunghezza si
 *  controlla prima perché `timingSafeEqual` solleva su lunghezze diverse — e
 *  quella non è un'informazione segreta: il digest ha lunghezza fissa. */
function equalWithoutTimes(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifica l'header `Stripe-Signature`.
 *
 * Forma: `t=1699999999,v1=<hex>,v0=<hex>` — e i `v1` possono essere PIÙ DI UNO
 * durante una rotazione del segreto. Si accetta se ne torna anche uno solo,
 * altrimenti ruotare il segreto vorrebbe dire buttare gli eventi in volo.
 *
 * `v0` si ignora: è lo schema vecchio, e accettarlo significherebbe tenere in
 * piedi per sempre una verifica più debole di quella che sappiamo fare.
 *
 * **Non solleva mai.** Ogni strada che non arriva a un HMAC buono torna un
 * motivo: una verifica che lancia un'eccezione, in una rotta, diventa un `500`
 * che Stripe interpreta come «riprova» — e allora un evento malformato torna
 * per giorni.
 */
export function verificaFirmaWebhook(
  corpoGrezzo: string,
  header: string | null,
  segreto: string | null,
  ora: number,
  tolleranzaMs: number = TOLLERANZA_MS,
): OutcomeSignature {
  if (!segreto) return { ok: false, motivo: "no_secret" };
  if (!header || !header.trim()) return { ok: false, motivo: "missing_header" };

  let t: string | null = null;
  const firme: string[] = [];
  for (const pezzo of header.split(",")) {
    const i = pezzo.indexOf("=");
    if (i < 0) continue;
    const k = pezzo.slice(0, i).trim();
    const v = pezzo.slice(i + 1).trim();
    if (k === "t" && t === null) t = v;
    else if (k === "v1" && v) firme.push(v);
  }
  if (t === null || firme.length === 0) return { ok: false, motivo: "malformed_header" };

  // `Number()` su "" darebbe 0 — cioè un timestamp validissimo del 1970, che
  // poi cadrebbe su `too_old` mascherando un header rotto da un rigioco.
  if (!/^\d+$/.test(t)) return { ok: false, motivo: "bad_timestamp" };
  const tsMs = Number(t) * 1000;
  if (!Number.isFinite(tsMs)) return { ok: false, motivo: "bad_timestamp" };

  // La finestra si controlla PRIMA dell'HMAC: un evento vecchio è da buttare
  // comunque, e non c'è motivo di spendere un digest per dirlo.
  if (tolleranzaMs > 0 && ora - tsMs > tolleranzaMs) return { ok: false, motivo: "too_old" };

  // Il segreto si usa INTERO, prefisso `whsec_` compreso: è la chiave HMAC per
  // come la usa Stripe. Toglierlo produce un digest che non torna mai, ed è
  // l'errore classico di chi reimplementa questa verifica.
  const atteso = createHmac("sha256", segreto).update(signedLoad(t, corpoGrezzo), "utf8").digest("hex");
  for (const f of firme) {
    if (equalWithoutTimes(atteso, f.toLowerCase())) return { ok: true };
  }
  return { ok: false, motivo: "bad_signature" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dall'evento di Stripe a una decisione che questa macchina sa prendere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cosa fare di un evento verificato.
 *
 * Tre azioni e non un numero libero di effetti: chi ne aggiunge una la aggiunge
 * QUI e il compilatore gli chiede di gestirla nella rotta, invece di far
 * crescere un `switch` dentro un handler HTTP — che è il modo in cui un webhook
 * diventa il posto dove vive la metà nascosta delle regole.
 */
export type ActionEvent =
  /** L'evento porta un gettone di licenza: si passa alla porta unica, che lo
   *  riverifica. Stripe non concede, consegna. */
  | { tipo: "install_token"; token: string }
  /** L'abbonamento è finito: si torna al piano gratuito. Tocca SOLO la
   *  raggiungibilità da fuori e i posti — l'uso locale non passa di qui. */
  | { tipo: "remove_license" }
  /** Ricevuto, capito, niente da fare. È la risposta giusta per la maggior
   *  parte degli eventi: Stripe ne manda molti più di quanti ce ne servano. */
  | { tipo: "ignore"; perche: string };

export interface EventStripe {
  id: string;
  type: string;
  /** L'installazione a cui l'evento si riferisce, se l'evento lo dice. */
  installationId: string | null;
  azione: ActionEvent;
}

function stringa(o: unknown): string | null {
  return typeof o === "string" && o.trim() ? o.trim() : null;
}

function oggetto(o: unknown): Record<string, unknown> | null {
  return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : null;
}

/**
 * Dove può stare l'identificativo dell'installazione, in ordine di preferenza.
 *
 * `client_reference_id` lo mette il checkout; `metadata.installation_id` lo
 * portano l'abbonamento e la sessione, perché il checkout lo copia anche in
 * `subscription_data.metadata` — senza quel passaggio gli eventi di
 * abbonamento, che arrivano MESI dopo, non saprebbero più di chi parlano.
 */
function leggiInstallationId(dato: Record<string, unknown>): string | null {
  const meta = oggetto(dato.metadata);
  return stringa(dato.client_reference_id)
    ?? (meta ? stringa(meta.installation_id) : null);
}

function readToken(dato: Record<string, unknown>): string | null {
  const meta = oggetto(dato.metadata);
  return meta ? stringa(meta.license_token) : null;
}

/**
 * Gli stati di un abbonamento in cui il servizio è FINITO.
 *
 * `past_due` non c'è di proposito: è un pagamento che non è andato a buon fine
 * e che Stripe ritenterà: togliere la licenza al primo tentativo fallito
 * significa spegnere il prodotto a qualcuno la cui carta è semplicemente
 * scaduta, mentre il rinnovo automatico sta ancora lavorando.
 */
const STATI_FINITI = new Set(["canceled", "unpaid", "incomplete_expired"]);

/**
 * Interpreta un evento GIÀ VERIFICATO.
 *
 * Il default è `ignore`: un tipo di evento che non conosciamo non è un errore e
 * non deve diventare un `4xx` — Stripe lo rimanderebbe. Un webhook che risponde
 * male a ciò che non gli interessa si trasforma in una coda di consegne fallite
 * che nasconde quelle vere.
 */
export function interpretaEvento(corpo: unknown): EventStripe | null {
  const e = oggetto(corpo);
  if (!e) return null;
  const id = stringa(e.id);
  const type = stringa(e.type);
  if (!id || !type) return null;

  const dato = oggetto(oggetto(e.data)?.object) ?? {};
  const installationId = leggiInstallationId(dato);
  const base = { id, type, installationId };

  switch (type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      // Su `updated` lo stato conta: è l'evento con cui arriva anche una
      // disdetta che ha già avuto effetto.
      const stato = stringa(dato.status);
      if (stato && STATI_FINITI.has(stato)) {
        return { ...base, azione: { tipo: "remove_license" } };
      }
      const token = readToken(dato);
      if (token) return { ...base, azione: { tipo: "install_token", token } };
      // Pagato ma senza gettone: non è un guasto di questa macchina. Il
      // gettone lo conia il servizio che ha la chiave privata, e finché non
      // arriva NON si inventa niente — restare sul piano gratuito è il verso
      // giusto in cui sbagliare.
      return { ...base, azione: { tipo: "ignore", perche: "no_token_in_event" } };
    }

    case "customer.subscription.deleted":
      return { ...base, azione: { tipo: "remove_license" } };

    default:
      return { ...base, azione: { tipo: "ignore", perche: "unhandled_type" } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aprire un checkout
// ─────────────────────────────────────────────────────────────────────────────

export type CodeCheckout =
  | "not_configured"   // manca la chiave o il listino: il caso normale
  | "no_installation"  // non sappiamo per chi stiamo comprando
  | "bad_seats"
  | "upstream_error"   // Stripe ha risposto male
  | "unreachable";     // non si è riusciti a parlare con Stripe

export type OutcomeCheckout =
  | { ok: true; url: string; id: string }
  | { ok: false; codice: CodeCheckout };

export interface OptionsCheckout {
  config: ConfigStripe;
  installationId: string;
  posti: number;
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: typeof fetch;
}

/** Tetto sui posti chiedibili. Non è una regola commerciale: è il limite oltre
 *  il quale un numero è quasi certamente un errore di battitura, e lo si ferma
 *  prima che diventi un addebito. */
export const POSTI_MAX_CHECKOUT = 500;

/**
 * Crea una Checkout Session e torna l'indirizzo a cui mandare la persona.
 *
 * L'`installationId` viaggia in TRE posti — `client_reference_id`, i metadati
 * della sessione e quelli dell'ABBONAMENTO — e il terzo è quello che conta:
 * gli eventi di rinnovo e di disdetta arrivano mesi dopo, portano l'oggetto
 * `subscription` e non la sessione, e senza quei metadati non si saprebbe più
 * a quale macchina si riferiscono.
 *
 * **Non solleva mai**: una rete che non risponde torna `unreachable`, non
 * un'eccezione che risale fino a far sembrare rotta l'applicazione.
 */
export async function creaCheckout(o: OptionsCheckout): Promise<OutcomeCheckout> {
  const { config: c } = o;
  if (!c.secretKey || !c.priceId) return { ok: false, codice: "not_configured" };
  if (!o.installationId.trim()) return { ok: false, codice: "no_installation" };
  const posti = Math.floor(o.posti);
  if (!Number.isFinite(posti) || posti < 1 || posti > POSTI_MAX_CHECKOUT) {
    return { ok: false, codice: "bad_seats" };
  }

  const corpo = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": c.priceId,
    "line_items[0][quantity]": String(posti),
    client_reference_id: o.installationId,
    "metadata[installation_id]": o.installationId,
    "subscription_data[metadata][installation_id]": o.installationId,
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
  });

  const f = o.fetchImpl ?? fetch;
  let risposta: Response;
  try {
    risposta = await f(`${c.apiBase}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        // La chiave esce di qui e va SOLO a Stripe, in un header, su https.
        authorization: `Bearer ${c.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: corpo.toString(),
    });
  } catch {
    return { ok: false, codice: "unreachable" };
  }

  if (!risposta.ok) return { ok: false, codice: "upstream_error" };
  let dato: unknown;
  try {
    dato = await risposta.json();
  } catch {
    return { ok: false, codice: "upstream_error" };
  }
  const o2 = oggetto(dato);
  const url = o2 ? stringa(o2.url) : null;
  const id = o2 ? stringa(o2.id) : null;
  if (!url || !id) return { ok: false, codice: "upstream_error" };
  return { ok: true, url, id };
}
