/**
 * Un WebSocket dentro il tubo: aprirlo, parlarci nei due versi, chiuderlo.
 *
 * ── PERCHÉ NON BASTA LO SCAMBIO RICHIESTA/RISPOSTA ──────────────────────────
 * `relay-http.ts` sa fare una domanda e sentirsi rispondere. Un WebSocket non è
 * quello: è una conversazione che dura, dove i due capi parlano quando vogliono
 * e nessuno dei due «risponde». Il client ne apre QUATTRO diversi e ognuno ha
 * vita sua — quello dell'applicazione (`/ws`), quello di ogni terminale
 * (`/ws/terminal/:id`) e quello di ogni pannello browser (`/ws/browser/:id`) —
 * tutti sopra lo stesso tubo, tutti da tenere separati.
 *
 * ── LA FORMA: DUE CANALI, UN NOME SOLO ──────────────────────────────────────
 * I numeri di stream sono spartiti per parità (`latoDiStream`), quindi un capo
 * non può scrivere sulla corsia dell'altro. Un socket è perciò una COPPIA di
 * canali: l'ospite apre il suo (dispari) chiedendo il percorso, la macchina
 * apre il proprio (pari) dichiarando com'è andata. Il nome del socket, per
 * tutti e due, è il numero dello stream dell'OSPITE: un identificatore solo, e
 * nessuna tabella da tenere d'accordo.
 *
 * ── PERCHÉ LA CHIUSURA È UNO STREAM A PARTE ─────────────────────────────────
 * Perché ha un codice e un motivo, e un `reset` del tubo ha solo una parola di
 * un vocabolario chiuso che parla del TUBO, non del socket. Buttare via
 * `1000 normale` contro `1011 errore del server` vorrebbe dire che da fuori
 * rete ogni chiusura si legge uguale, e chi si riconnette non sa se deve.
 *
 * ── LA REGOLA CHE GOVERNA OGNI SCELTA QUI ───────────────────────────────────
 * Chi apre questi socket è FUORI dalla rete di casa. Il percorso è un percorso
 * e mai un URL (dove si rigioca lo decide la macchina, `risolviUrlLocale`), e
 * le intestazioni passano dalla stessa lista di `relay-http.ts` — che è il
 * punto: una regola sola, non due copie che un giorno divergono.
 */
import { intestazioniRichiesta, type Intestazioni } from "./relay-http";

/** Il canale dell'OSPITE: porta la richiesta di apertura e poi i suoi
 *  messaggi. */
export const GENERE_WS = "ws";
/** Il canale della MACCHINA: porta l'esito dell'apertura e poi i suoi. */
export const GENERE_WS_APERTO = "wsok";
/** La chiusura, con codice e motivo. Vale nei due sensi. */
export const GENERE_WS_CHIUSO = "wsc";

/** Lo stato che dice «il socket è aperto»: lo stesso numero che l'HTTP usa per
 *  un upgrade riuscito, così chi legge non deve imparare un secondo
 *  vocabolario. */
export const WS_APERTO = 101;

/** La testa del canale dell'ospite: che socket vuole. */
export interface TestaWs {
  /** Percorso e query, sempre da `/`. Mai un URL assoluto. */
  p: string;
  h?: Intestazioni;
  /** I sottoprotocolli richiesti, in ordine di preferenza. */
  sp?: string[];
}

/** La testa del canale della macchina: com'è andata. */
export interface TestaWsAperto {
  /** Lo stream dell'ospite a cui questo canale fa da coppia. È anche il nome
   *  del socket per tutti e due i capi. */
  re: number;
  /**
   * `WS_APERTO` = collegato. Qualsiasi altro numero dice PERCHÉ non lo è, con
   * il vocabolario dell'HTTP: `503` la raggiungibilità da fuori non è
   * configurata, `400` il percorso sceglieva un'altra destinazione, `502` la
   * stretta di mano con l'ascoltatore non è riuscita.
   *
   * `502` e non lo stato vero dell'ascoltatore, ed è una rinuncia consapevole:
   * un client WebSocket non espone la risposta di un upgrade fallito, quindi
   * riportare «404» qui vorrebbe dire inventarselo. Meglio un numero che dice
   * quello che si sa davvero.
   */
  s: number;
  /** Il sottoprotocollo scelto, se ce n'è uno. */
  sp?: string;
}

/** La testa dello stream di chiusura: quale socket muore. */
export interface TestaWsChiuso {
  w: number;
}

/**
 * Il corpo dello stream di chiusura.
 *
 * `c` è il codice del WebSocket, `r` il motivo leggibile. Nessuno dei due si
 * inventa: se il capo di là non li ha dati, si manda `1000` con motivo vuoto —
 * che è ciò che dice una chiusura pulita.
 */
export interface ChiusuraWs {
  c: number;
  r: string;
}

/** Chiusura normale. */
export const WS_CHIUSURA_NORMALE = 1000;
/**
 * «Il filo si è rotto senza saluti.»
 *
 * È il codice che un browser produce da solo quando la connessione cade, e
 * qui vuol dire la stessa cosa: il tubo ha chiuso il canale senza che nessuno
 * dei due capi abbia dichiarato una chiusura. Non si può MANDARE su un
 * WebSocket vero — è riservato — quindi chi lo riceve dal tubo non lo gira a
 * `close()`: chiude e basta.
 */
export const WS_CHIUSURA_ANOMALA = 1006;

const MAX_TESTA = 16 * 1024;
const MAX_PROTOCOLLI = 16;
const MAX_PROTOCOL = 128;
const MAX_REASON = 512;
const MAX_INTESTAZIONI = 100;

/** Il nome di un sottoprotocollo è un token HTTP: tutto il resto — spazi,
 *  virgole, ritorni a capo — è ciò con cui si spezza in due un'intestazione a
 *  valle. */
const PROTOCOLLO_VALIDO = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function leggiIntestazioni(raw: unknown): Intestazioni | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_INTESTAZIONI) return null;
  const out: Intestazioni = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length !== 2) return null;
    const [n, v] = c as unknown[];
    if (typeof n !== "string" || typeof v !== "string") return null;
    out.push([n, v]);
  }
  return out;
}

function readProtocols(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PROTOCOLLI) return null;
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0 || p.length > MAX_PROTOCOL) return null;
    if (!PROTOCOLLO_VALIDO.test(p)) return null;
    out.push(p);
  }
  return out;
}

function oggetto(raw: string | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TESTA) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  return o as Record<string, unknown>;
}

/** La testa del canale dell'ospite, letta stretta. `null` = il canale muore:
 *  questo arriva da fuori. */
export function leggiTestaWs(raw: string | undefined): TestaWs | null {
  const m = oggetto(raw);
  if (!m) return null;
  if (typeof m.p !== "string") return null;
  const h = "h" in m && m.h !== undefined ? leggiIntestazioni(m.h) : undefined;
  if (h === null) return null;
  const sp = "sp" in m && m.sp !== undefined ? readProtocols(m.sp) : undefined;
  if (sp === null) return null;
  return { p: m.p, ...(h !== undefined ? { h } : {}), ...(sp !== undefined ? { sp } : {}) };
}

/** …e quella della macchina, con la stessa severità: anche la macchina, vista
 *  dall'ospite, è un capo remoto. */
export function leggiTestaWsAperto(raw: string | undefined): TestaWsAperto | null {
  const m = oggetto(raw);
  if (!m) return null;
  if (typeof m.re !== "number" || !Number.isInteger(m.re) || m.re < 0) return null;
  if (typeof m.s !== "number" || !Number.isInteger(m.s) || m.s < 100 || m.s > 599) return null;
  if ("sp" in m && m.sp !== undefined) {
    if (typeof m.sp !== "string" || m.sp.length === 0 || m.sp.length > MAX_PROTOCOL) return null;
    if (!PROTOCOLLO_VALIDO.test(m.sp)) return null;
    return { re: m.re, s: m.s, sp: m.sp };
  }
  return { re: m.re, s: m.s };
}

export function leggiTestaWsChiuso(raw: string | undefined): TestaWsChiuso | null {
  const m = oggetto(raw);
  if (!m) return null;
  if (typeof m.w !== "number" || !Number.isInteger(m.w) || m.w < 0) return null;
  return { w: m.w };
}

/**
 * Il corpo di una chiusura.
 *
 * I codici fuori dall'intervallo che un WebSocket accetta si rifiutano invece
 * di essere corretti: `close(0)` è un'eccezione a valle, e correggerlo in
 * silenzio vorrebbe dire consegnare una chiusura che nessuno ha chiesto.
 */
export function leggiChiusuraWs(raw: string | Uint8Array | undefined): ChiusuraWs | null {
  const testo = typeof raw === "string" ? raw : raw === undefined ? undefined : new TextDecoder().decode(raw);
  const m = oggetto(testo);
  if (!m) return null;
  if (typeof m.c !== "number" || !Number.isInteger(m.c) || m.c < 1000 || m.c > 4999) return null;
  if (typeof m.r !== "string" || m.r.length > MAX_REASON) return null;
  return { c: m.c, r: m.r };
}

/** Una testa pronta per `h`. Una funzione e non uno `JSON.stringify` sparso,
 *  così il posto dove la testa diventa stringa è UNO. */
export function scriviTestaWs(t: TestaWs | TestaWsAperto | TestaWsChiuso): string {
  return JSON.stringify(t);
}

export function scriviChiusuraWs(c: ChiusuraWs): string {
  return JSON.stringify(c);
}

/**
 * Ciò che di una richiesta di apertura si consegna all'ascoltatore.
 *
 * È la lista di `relay-http.ts` — una regola sola per «cosa può dichiarare chi
 * arriva da fuori», non una seconda copia che un giorno diverge — più le
 * intestazioni della STRETTA DI MANO. Quelle appartengono alla connessione fra
 * questa macchina e l'ascoltatore, e la genera il client vero: `sec-websocket-key`
 * è la chiave con cui l'ascoltatore calcola l'`accept`, `sec-websocket-version`
 * dice quale grammatica si parla, `sec-websocket-protocol` lo si porta a parte
 * perché è una scelta e non un'intestazione da copiare. Lasciarle passare
 * vorrebbe dire mandarne due copie diverse nella stessa richiesta — e quale
 * delle due vince lo decide un parser, cioè nessuno.
 */
export function intestazioniUpgrade(h: Intestazioni | undefined): Intestazioni {
  return intestazioniRichiesta(h).filter(([n]) => !n.startsWith("sec-websocket-"));
}

/**
 * Il codice si può MANDARE su un `close()` vero?
 *
 * `1005` e `1006` li produce il browser da solo e sono riservati: passarli a
 * `close()` è un'eccezione, non una chiusura. Sopra `4999` non esistono. Chi
 * riceve una chiusura dal tubo passa di qui prima di girarla al socket vero.
 */
export function codiceInviabile(c: number): boolean {
  return c === WS_CHIUSURA_NORMALE || (c >= 3000 && c <= 4999);
}
