/**
 * Il protocollo del relay: cosa si dicono una macchina e un ospite attraverso
 * un punto d'incontro che non capisce quello che inoltra.
 *
 * ── PERCHÉ ESISTE PRIMA DEL TRASPORTO ───────────────────────────────────────
 * Scritto qui, e non dentro un Worker, perché la scelta di Cloudflare sia
 * REVERSIBILE davvero e non solo a parole. Un protocollo che vive dentro
 * l'implementazione del suo trasporto non è portabile: è il trasporto. Con
 * questo modulo, spostare il relay su una macchina propria — il caso del
 * cliente con vincoli di sovranità del dato — vuol dire riscrivere chi
 * consegna le buste, non cosa c'è dentro.
 *
 * ── LE TRE REGOLE ───────────────────────────────────────────────────────────
 * 1. IL RELAY NON CAPISCE. Ogni busta ha un involucro in chiaro — abbastanza da
 *    sapere a chi consegnarla — e un contenuto opaco. Il relay legge solo
 *    l'involucro. Non è una promessa commerciale: è la forma del tipo.
 *
 * 2. ARRIVARE NON È ESSERE AUTORIZZATI. Il protocollo stabilisce un canale,
 *    niente altro. Chi sei e cosa puoi vedere lo decide l'installazione, con le
 *    stesse regole della rete locale. Il relay non ha un'opinione sull'identità,
 *    e non deve averla: due autorità sull'identità vanno tenute d'accordo per
 *    sempre.
 *
 * 3. IL LINK È LA CREDENZIALE. Chi ha il link ha la chiave, perché la chiave
 *    viaggia nel frammento dell'URL — la parte che il browser non manda al
 *    server. Quindi il link scade e si revoca, e chi lo produce deve vederlo
 *    scritto.
 */

/** Versione del protocollo. Un capo che non la riconosce chiude invece di
 *  indovinare: due versioni che si arrangiano è il modo in cui un formato
 *  smette di avere una definizione. */
export const RELAY_PROTOCOL_VERSION = 1;

// ── Dalla MACCHINA al relay ────────────────────────────────────────────────

/** «Sono questa installazione, sono viva.» Primo messaggio, sempre. */
export interface RegistraInstallazione {
  t: "hello";
  v: number;
  /** Identifica l'installazione presso il relay. NON è il segreto della
   *  condivisione: quello sta nel frammento del link e il relay non lo vede. */
  installationId: string;
  /** Prova che questa installazione è chi dice di essere. */
  token: string;
}

/** «Questa busta va all'ospite `to`.» */
export interface BustaVersoOspite {
  t: "to-guest";
  /** La sessione ospite, assegnata dal relay. */
  to: string;
  /** Opaco al relay. */
  payload: string;
}

// ── Dall'OSPITE al relay ───────────────────────────────────────────────────

/** «Voglio parlare con questa installazione.» Il segreto del link NON compare:
 *  serve a decifrare, non a farsi instradare. */
export interface ApriSessioneOspite {
  t: "guest-open";
  v: number;
  installationId: string;
  /** Riferimento pubblico della condivisione. Il relay lo usa per instradare e
   *  per far scadere; non ne ricava il contenuto. */
  shareRef: string;
}

/** «Questa busta va alla macchina.» */
export interface BustaVersoMacchina {
  t: "to-host";
  payload: string;
}

// ── Dal RELAY ai due capi ──────────────────────────────────────────────────

/** Al relay è andata bene. */
export interface Accolto {
  t: "ready";
  v: number;
  /** Presente solo verso un ospite: la sessione che gli è stata assegnata. */
  sessionId?: string;
}

/** Un ospite si è collegato o se n'è andato. La macchina lo deve sapere per
 *  smettere di mandare buste a nessuno. */
export interface OspiteCambiato {
  t: "guest-joined" | "guest-left";
  sessionId: string;
}

/**
 * Rifiuto. `motivo` è una parola del vocabolario, non una frase: chi la legge
 * deve poterci decidere sopra, e una frase la si può solo mostrare.
 *
 * `host-offline` merita di esistere separato da tutti gli altri perché non è un
 * errore: è la macchina spenta, e all'ospite va detto proprio quello invece di
 * una pagina vuota che si legge come «non ti hanno condiviso niente».
 */
export interface Rifiutato {
  t: "denied";
  motivo: "bad-version" | "bad-token" | "unknown-installation" | "expired" | "revoked" | "host-offline";
}

export type DaMacchina = RegistraInstallazione | BustaVersoOspite;
export type DaOspite = ApriSessioneOspite | BustaVersoMacchina;
export type DaRelay = Accolto | OspiteCambiato | Rifiutato | BustaVersoOspite | BustaVersoMacchina;
export type MessaggioRelay = DaMacchina | DaOspite | DaRelay;

/**
 * Cosa il relay può leggere di una busta: l'involucro, e basta.
 *
 * Esiste come funzione — e non come commento — perché sia verificabile. Un test
 * le passa una busta e controlla che il contenuto non compaia nel risultato: se
 * un giorno qualcuno aggiungesse un campo in chiaro «tanto serve per il log»,
 * quel test fallisce.
 */
export function involucro(m: MessaggioRelay): Record<string, unknown> {
  const base: Record<string, unknown> = { t: m.t };
  if ("v" in m && m.v !== undefined) base.v = m.v;
  if ("installationId" in m) base.installationId = m.installationId;
  if ("to" in m) base.to = m.to;
  if ("sessionId" in m && m.sessionId !== undefined) base.sessionId = m.sessionId;
  if ("shareRef" in m) base.shareRef = m.shareRef;
  if ("motivo" in m) base.motivo = m.motivo;
  return base;
}

/** Una busta porta contenuto opaco? Serve a chi instrada per sapere che non
 *  deve nemmeno provare a guardarci dentro. */
export function haContenutoOpaco(m: MessaggioRelay): m is BustaVersoOspite | BustaVersoMacchina {
  return m.t === "to-guest" || m.t === "to-host";
}

/**
 * Riconosce un messaggio in arrivo, o dice di no.
 *
 * Validazione stretta di proposito: un capo che accetta ciò che quasi capisce è
 * un capo che un giorno accetta ciò che non capisce affatto. `null` = si chiude.
 */
export function leggiMessaggio(raw: unknown): MessaggioRelay | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const t = m.t;
  const str = (k: string) => typeof m[k] === "string" && (m[k] as string).length > 0;

  switch (t) {
    case "hello":
      return m.v === RELAY_PROTOCOL_VERSION && str("installationId") && str("token")
        ? { t, v: m.v as number, installationId: m.installationId as string, token: m.token as string }
        : null;
    case "guest-open":
      return m.v === RELAY_PROTOCOL_VERSION && str("installationId") && str("shareRef")
        ? { t, v: m.v as number, installationId: m.installationId as string, shareRef: m.shareRef as string }
        : null;
    case "to-guest":
      return str("to") && typeof m.payload === "string"
        ? { t, to: m.to as string, payload: m.payload }
        : null;
    case "to-host":
      return typeof m.payload === "string" ? { t, payload: m.payload } : null;
    case "ready":
      return m.v === RELAY_PROTOCOL_VERSION
        ? { t, v: m.v as number, ...(str("sessionId") ? { sessionId: m.sessionId as string } : {}) }
        : null;
    case "guest-joined":
    case "guest-left":
      return str("sessionId") ? { t, sessionId: m.sessionId as string } : null;
    case "denied":
      return typeof m.motivo === "string" && MOTIVI.has(m.motivo)
        ? { t, motivo: m.motivo as Rifiutato["motivo"] }
        : null;
    default:
      return null;
  }
}

const MOTIVI = new Set([
  "bad-version", "bad-token", "unknown-installation", "expired", "revoked", "host-offline",
]);
