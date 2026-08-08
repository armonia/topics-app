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

// ───────────────────────────────────────────────────────────────────────────
// IL TUBO: la busta INTERNA, dentro `payload`
// ───────────────────────────────────────────────────────────────────────────
/**
 * ── PERCHÉ SERVE ────────────────────────────────────────────────────────────
 * Fin qui una sessione era uno stream: il relay instrada sul solo `to`, quindi
 * fra due capi c'è UNA corsia. Va bene per un link di condivisione — una
 * domanda, una risposta — e non basta per una sessione vera, dove decine di
 * richieste, di risalite di eventi e di trasferimenti convivono e nessuna può
 * aspettare che finisca quella davanti. Senza uno strato che le distingua,
 * l'unica corsia diventa una coda: la richiesta lunga blocca tutte le altre, e
 * la risposta che torna non si sa a chi appartenga.
 *
 * ── PERCHÉ STA QUI DENTRO E NON NELL'INVOLUCRO ──────────────────────────────
 * Sarebbe comodo mettere `streamId` accanto a `to`: il relay potrebbe fare
 * cose furbe, riordinare, contare. È esattamente il motivo per cui non ci va.
 * Il giorno in cui il relay sa quanti stream ci sono, quali sono grossi e
 * quali durano, ha una descrizione del traffico che non gli spetta — e la
 * promessa «non capisce quello che inoltra» diventa «capisce un po'». Il tubo
 * viaggia DENTRO `payload`, che per il relay resta una stringa sola. La
 * funzione `involucro()` qui sopra è la prova, e un test la tiene vera.
 *
 * ── PERCHÉ I FRAME SONO PICCOLI, E DI TESTO ─────────────────────────────────
 * Due vincoli veri, non stilistici:
 *  1. Il Durable Object SCARTA i messaggi binari (`relay-do.ts`: la porta si
 *     chiude lì, non a valle). Quindi i byte viaggiano in base64 dentro JSON,
 *     e si pagano +33%. È il prezzo di non avere una seconda porta d'ingresso
 *     con regole tutte sue.
 *  2. Cloudflare taglia a 32 MiB il singolo messaggio RICEVUTO. Un solo frame
 *     grosso quanto un file non arriva, e un capo che ci prova non lo scopre
 *     dai suoi test ma da un utente. Si spezza a monte, in frame che ci stanno
 *     largamente, e si riassembla a valle.
 */

/**
 * ── COME SI FA EVOLVERE, VISTO CHE NON C'È UN NUMERO DI VERSIONE ────────────
 * Di proposito: `RELAY_PROTOCOL_VERSION` esiste perché il relay deve poter
 * chiudere in faccia a chi parla un'altra lingua, e il relay il tubo non lo
 * vede — un numero che nessuno trasmette e nessuno controlla è decorazione, e
 * la decorazione invecchia peggio del niente. Il punto di estensione vero è
 * `k`, il genere dello stream: aggiungere un genere è additivo, e un capo che
 * ne riceve uno che non conosce chiude QUELLO stream con `bad-frame` invece di
 * cadere. Un cambio incompatibile del formato dei frame vuole una trattativa
 * fra i due capi, che è un altro pezzo e non si finge qui con una costante.
 */

/** Il tetto di Cloudflare per un singolo messaggio ricevuto da un DO. Scritto
 *  qui perché chi sceglie una dimensione di frame lo veda, invece di scoprirlo
 *  in produzione. */
export const TUBO_LIMITE_CLOUDFLARE = 32 * 1024 * 1024;

/**
 * Quanti byte di CONTENUTO entrano in un frame prima di essere codificati.
 *
 * 96 KiB, scelti perché in base64 diventano esattamente 128 KiB (96 × 4/3) —
 * dentro la finestra 64–256 KiB e due ordini di grandezza sotto il tetto di
 * Cloudflare. Multiplo di 3, così ogni pezzo si codifica senza riempimento e
 * il rumore che si vede sul filo è tutto contenuto.
 */
export const TUBO_BYTE_PER_FRAME = 96 * 1024;

/**
 * Il massimo che si ACCETTA nel campo dati di un frame in arrivo.
 *
 * Più largo di quello che si emette, e di proposito: un capo che spezza a
 * misura leggermente diversa deve poter parlare lo stesso protocollo, mentre
 * un capo ostile che manda un frame da 32 MiB va fermato prima di allocarlo.
 * Un tetto che coincide con quello che si emette è un tetto che si rompe alla
 * prima variazione innocente.
 */
export const TUBO_DATI_MAX = 256 * 1024;

/** Da che capo del tubo si apre uno stream. Serve a spartirsi i numeri: gli
 *  identificatori pari sono della macchina, i dispari dell'ospite, e così due
 *  capi che aprono insieme non possono scegliere lo stesso. */
export type LatoTubo = "host" | "guest";

/** Come sono codificati i dati di un frame: testo così com'è, oppure byte in
 *  base64url. Uno stream non cambia idea a metà — mescolarli vorrebbe dire non
 *  sapere cosa si sta rimettendo insieme. */
export type CodificaTubo = "u" | "b";

/**
 * Perché uno stream finisce male. Vocabolario chiuso, come i motivi di
 * `denied`: chi lo legge deve poterci decidere sopra.
 *
 * `aborted` è l'unico che un capo manda apposta; gli altri li produce chi
 * riceve, quando ciò che gli arriva non sta in piedi.
 */
export type MotivoStream =
  | "aborted"           // il mittente ha rinunciato
  | "bad-frame"         // il frame non regge: fuori sequenza, fuori misura, fuori posto
  | "overflow"          // lo stream ha accumulato più di quanto si è disposti a tenere
  | "too-many-streams"; // troppi aperti insieme

/** «Apro uno stream.» Sempre `n: 0`. Può già portare il primo pezzo: una
 *  richiesta piccola diventa UN frame invece di due, e su un Durable Object
 *  che si paga a messaggio la differenza non è estetica. */
export interface ApriStream {
  f: "open";
  /** Identificatore dello stream. Pari = aperto dalla macchina, dispari
   *  dall'ospite. Cresce sempre: chi riceve rifiuta un numero già visto senza
   *  doversi ricordare quali. */
  s: number;
  n: 0;
  /** Che genere di stream è («req», «ws», …). Opaco al tubo: il tubo trasporta,
   *  non interpreta. */
  k: string;
  /** Testa dello stream: metadati che il destinatario sa leggere (metodo, path,
   *  intestazioni). Opaca anche questa. */
  h?: string;
  e?: CodificaTubo;
  d?: string;
  /** Non arriverà altro da questo capo per questo stream. */
  fin?: true;
}

/** Un pezzo. `n` cresce di uno per volta: un buco vuol dire che qualcosa si è
 *  perso o è stato infilato, e in nessuno dei due casi si tira a indovinare. */
export interface DatiStream {
  f: "data";
  s: number;
  n: number;
  e: CodificaTubo;
  d: string;
  fin?: true;
}

/** «Questo stream muore qui.» Vale in tutti e due i sensi e in qualsiasi
 *  momento, anche su uno stream che l'altro capo non conosce più. */
export interface ChiudiStream {
  f: "reset";
  s: number;
  motivo: MotivoStream;
}

export type FrameTubo = ApriStream | DatiStream | ChiudiStream;

// ── base64url, per i byte dentro il JSON ───────────────────────────────────
// Sta qui e non importato da `relay-crypto` perché il tubo deve poter esistere
// senza cifratura — nella rete di casa, dove non c'è nessun relay in mezzo, non
// si paga una dipendenza che non serve.

const B64_ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function aBase64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const a = b[i]!, c = b[i + 1], d = b[i + 2];
    s += B64_ALFABETO[a >> 2];
    s += B64_ALFABETO[((a & 3) << 4) | ((c ?? 0) >> 4)];
    if (c === undefined) break;
    s += B64_ALFABETO[((c & 15) << 2) | ((d ?? 0) >> 6)];
    if (d === undefined) break;
    s += B64_ALFABETO[d & 63];
  }
  return s;
}

/** `null` se la stringa non è base64url: un carattere fuori alfabeto è dato
 *  altrui che non si è capito, e si tratta come tale invece di produrre byte
 *  inventati. */
export function daBase64url(s: string): Uint8Array | null {
  const n = s.length;
  if (n % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0, acc = 0, bit = 0;
  for (let i = 0; i < n; i++) {
    const v = B64_ALFABETO.indexOf(s[i]!);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bit += 6;
    if (bit >= 8) {
      bit -= 8;
      out[o++] = (acc >> bit) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ── Lettura stretta di un frame ────────────────────────────────────────────

const MOTIVI_STREAM = new Set<string>(["aborted", "bad-frame", "overflow", "too-many-streams"]);

function idValido(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

function datiValidi(m: Record<string, unknown>): boolean {
  const haD = "d" in m && m.d !== undefined;
  const haE = "e" in m && m.e !== undefined;
  // O tutti e due o nessuno dei due: dati senza codifica sono byte di cui non
  // si sa cosa siano, e una codifica senza dati è una promessa vuota.
  if (haD !== haE) return false;
  if (!haD) return true;
  if (typeof m.d !== "string" || (m.e !== "u" && m.e !== "b")) return false;
  return (m.d as string).length <= TUBO_DATI_MAX;
}

/**
 * Riconosce un frame del tubo, o dice di no.
 *
 * Stessa severità di `leggiMessaggio`, e per lo stesso motivo: qui arriva roba
 * che ha attraversato una rete e un servizio di terzi. `null` = lo stream muore,
 * non «si prova lo stesso».
 */
export function leggiFrame(raw: unknown): FrameTubo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!idValido(m.s)) return null;

  switch (m.f) {
    case "open": {
      if (m.n !== 0 || typeof m.k !== "string" || m.k.length === 0) return null;
      if ("h" in m && m.h !== undefined && typeof m.h !== "string") return null;
      if ("fin" in m && m.fin !== undefined && m.fin !== true) return null;
      if (!datiValidi(m)) return null;
      const f: ApriStream = { f: "open", s: m.s, n: 0, k: m.k };
      if (typeof m.h === "string") f.h = m.h;
      if (typeof m.d === "string") { f.e = m.e as CodificaTubo; f.d = m.d; }
      if (m.fin === true) f.fin = true;
      return f;
    }
    case "data": {
      if (!idValido(m.n) || m.n < 1) return null;
      if (typeof m.d !== "string" || (m.e !== "u" && m.e !== "b")) return null;
      if (m.d.length > TUBO_DATI_MAX) return null;
      if ("fin" in m && m.fin !== undefined && m.fin !== true) return null;
      const f: DatiStream = { f: "data", s: m.s, n: m.n, e: m.e, d: m.d };
      if (m.fin === true) f.fin = true;
      return f;
    }
    case "reset":
      return typeof m.motivo === "string" && MOTIVI_STREAM.has(m.motivo)
        ? { f: "reset", s: m.s, motivo: m.motivo as MotivoStream }
        : null;
    default:
      return null;
  }
}

/** Un frame pronto da mettere in `payload`. Una funzione e non un
 *  `JSON.stringify` sparso, così il posto dove il tubo diventa una stringa è
 *  UNO — ed è lì che un domani si infila la cifratura. */
export function scriviFrame(f: FrameTubo): string {
  return JSON.stringify(f);
}

/** Il contrario: da `payload` a frame, senza che un JSON storto diventi
 *  un'eccezione a metà di un `onmessage`. */
export function leggiFramePayload(payload: string): FrameTubo | null {
  try {
    return leggiFrame(JSON.parse(payload));
  } catch {
    return null;
  }
}

// ── Spezzare ───────────────────────────────────────────────────────────────

/** Quanti byte si avanzano davvero per giro. `max` è un parametro pubblico —
 *  sta su `componiStream` e su `CapoTuboOpts` — e una misura sotto l'uno
 *  avanzerebbe di zero byte per volta: un ciclo che non finisce mai, che è
 *  peggio di un errore perché non si vede. */
function passoDiTaglio(max: number): number {
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
}

/**
 * Spezza del testo in pezzi che stanno in `max` BYTE UTF-8.
 *
 * Il taglio arretra fino a un confine di carattere. Tagliare a metà di una
 * sequenza UTF-8 non dà un errore: dà un carattere sbagliato in mezzo al testo,
 * che è il tipo di guasto che si scopre mesi dopo su una lingua che nessuno
 * aveva provato.
 *
 * Quando `max` è più piccolo di UN carattere non esiste nessun taglio lecito, e
 * l'unica scelta che non rovina il contenuto è SFORARE: si emette il carattere
 * intero, al più tre byte oltre la misura. Il tetto vero è quello di chi riceve
 * (`TUBO_DATI_MAX`, largo il triplo di quanto si emette), quindi tre byte non
 * fanno rifiutare niente — mentre un carattere spezzato non torna più indietro.
 */
export function dividiTesto(testo: string, max: number = TUBO_BYTE_PER_FRAME): string[] {
  if (testo.length === 0) return [];
  const byte = new TextEncoder().encode(testo);
  if (byte.length <= max) return [testo];
  const passo = passoDiTaglio(max);
  const continuazione = (n: number) => (byte[n]! & 0b1100_0000) === 0b1000_0000;
  const dec = new TextDecoder();
  const out: string[] = [];
  let i = 0;
  while (i < byte.length) {
    let fine = Math.min(i + passo, byte.length);
    // 10xxxxxx = byte di continuazione: si sta in mezzo a un carattere.
    while (fine > i && fine < byte.length && continuazione(fine)) fine--;
    if (fine === i) {
      // Si è arretrato fino all'inizio: il carattere qui non ci sta in `max`.
      // Si va avanti fino alla fine di QUESTO carattere invece di tagliarlo.
      fine = i + 1;
      while (fine < byte.length && continuazione(fine)) fine++;
    }
    out.push(dec.decode(byte.subarray(i, fine)));
    i = fine;
  }
  return out;
}

/** Spezza dei byte in pezzi già codificati in base64url. Ogni pezzo si decodifica
 *  da solo: rimetterli insieme è concatenare byte, non stringhe. */
export function dividiBinario(b: Uint8Array, max: number = TUBO_BYTE_PER_FRAME): string[] {
  if (b.length === 0) return [];
  const passo = passoDiTaglio(max);
  const out: string[] = [];
  for (let i = 0; i < b.length; i += passo) out.push(aBase64url(b.subarray(i, i + passo)));
  return out;
}

/**
 * Tutti i frame di uno stream, dal primo all'ultimo, `fin` compreso.
 *
 * Uno stream senza dati è UN solo frame `open` con `fin`: serve, ed è il caso
 * di chi apre una corsia per ricevere, non per mandare.
 */
export function componiStream(opts: {
  s: number;
  k: string;
  h?: string;
  dati?: string | Uint8Array;
  max?: number;
}): FrameTubo[] {
  const max = opts.max ?? TUBO_BYTE_PER_FRAME;
  const testo = typeof opts.dati === "string";
  const pezzi = opts.dati === undefined
    ? []
    : testo ? dividiTesto(opts.dati as string, max) : dividiBinario(opts.dati as Uint8Array, max);
  const e: CodificaTubo = testo ? "u" : "b";

  const apri: ApriStream = { f: "open", s: opts.s, n: 0, k: opts.k };
  if (opts.h !== undefined) apri.h = opts.h;
  if (pezzi.length > 0) { apri.e = e; apri.d = pezzi[0]!; }
  if (pezzi.length <= 1) apri.fin = true;

  const frames: FrameTubo[] = [apri];
  for (let i = 1; i < pezzi.length; i++) {
    const d: DatiStream = { f: "data", s: opts.s, n: i, e, d: pezzi[i]! };
    if (i === pezzi.length - 1) d.fin = true;
    frames.push(d);
  }
  return frames;
}

/** I numeri di stream di un capo. Pari la macchina, dispari l'ospite: due capi
 *  che aprono nello stesso istante non possono collidere, e non serve nessuna
 *  trattativa per stabilirlo. */
export function creaContatoreStream(lato: LatoTubo): () => number {
  let n = lato === "host" ? 0 : 1;
  return () => { const v = n; n += 2; return v; };
}

/** Da che capo è stato aperto uno stream, letto dal numero. */
export function latoDiStream(s: number): LatoTubo {
  return s % 2 === 0 ? "host" : "guest";
}

// ── Riassemblare ───────────────────────────────────────────────────────────

export type EsitoTubo =
  | { esito: "aperto"; s: number; k: string; h?: string }
  | { esito: "parziale"; s: number; byte: number }
  | { esito: "completo"; s: number; k: string; h?: string; e: "u"; dati: string }
  | { esito: "completo"; s: number; k: string; h?: string; e: "b"; dati: Uint8Array }
  | { esito: "chiuso"; s: number; motivo: MotivoStream }
  | { esito: "errore"; s: number; motivo: MotivoStream };

export interface OpzioniRiassemblatore {
  /** Da che capo arrivano gli stream che si ricevono. Serve a rifiutare un
   *  numero di parità sbagliata: chi lo manda sta usando i numeri dell'altro,
   *  e da lì nascono due stream con lo stesso identificatore. */
  latoRemoto: LatoTubo;
  /** Quanti stream aperti insieme si accettano. Senza tetto, aprire e non
   *  chiudere mai è un modo gratuito per far crescere la memoria di chi
   *  ascolta. */
  maxStream?: number;
  /** Quanti byte può accumulare UNO stream prima del `fin`. Stesso motivo:
   *  il tubo non sa quanto è grande ciò che trasporta finché non finisce, e
   *  «finché non finisce» non può voler dire «per sempre». */
  maxByteStream?: number;
}

interface StatoStream {
  k: string;
  h?: string;
  e: CodificaTubo | null;
  prossimo: number;
  byte: number;
  testo: string[];
  binario: Uint8Array[];
}

/**
 * Rimette insieme gli stream che arrivano da un capo.
 *
 * Ogni rifiuto è definitivo per QUELLO stream e innocuo per gli altri: è il
 * motivo per cui il tubo esiste. Un frame storto su una richiesta non deve far
 * cadere le altre trenta che stanno viaggiando sulla stessa sessione.
 */
export function creaRiassemblatore(opts: OpzioniRiassemblatore) {
  const maxStream = opts.maxStream ?? 64;
  const maxByte = opts.maxByteStream ?? 16 * 1024 * 1024;
  const aperti = new Map<number, StatoStream>();
  /** Il più alto numero già visto. Basta questo per non riaccettare un
   *  identificatore riusato, senza tenere l'elenco di tutti quelli passati —
   *  che sarebbe memoria che cresce per tutta la durata della sessione. */
  let massimoVisto = -1;

  const fallisci = (s: number, motivo: MotivoStream): EsitoTubo => {
    aperti.delete(s);
    return { esito: "errore", s, motivo };
  };

  function accumula(st: StatoStream, e: CodificaTubo, d: string): MotivoStream | null {
    if (st.e !== null && st.e !== e) return "bad-frame";
    st.e = e;
    if (e === "u") {
      const n = new TextEncoder().encode(d).length;
      if (st.byte + n > maxByte) return "overflow";
      st.byte += n;
      st.testo.push(d);
      return null;
    }
    const b = daBase64url(d);
    if (b === null) return "bad-frame";
    if (st.byte + b.length > maxByte) return "overflow";
    st.byte += b.length;
    st.binario.push(b);
    return null;
  }

  function completa(s: number, st: StatoStream): EsitoTubo {
    aperti.delete(s);
    const comune = { esito: "completo" as const, s, k: st.k, ...(st.h !== undefined ? { h: st.h } : {}) };
    if (st.e === "b") {
      const tot = new Uint8Array(st.byte);
      let o = 0;
      for (const p of st.binario) { tot.set(p, o); o += p.length; }
      return { ...comune, e: "b", dati: tot };
    }
    return { ...comune, e: "u", dati: st.testo.join("") };
  }

  return {
    ricevi(f: FrameTubo): EsitoTubo {
      // Un reset vale sempre e non discute: anche su uno stream che qui non
      // esiste più, perché i due capi possono averlo chiuso nello stesso
      // istante e nessuno dei due ha sbagliato.
      if (f.f === "reset") {
        aperti.delete(f.s);
        // Il segnaposto vale solo per la corsia REMOTA. Pari e dispari stanno
        // nello stesso spazio numerico, quindi alzarlo con un reset sulla corsia
        // di QUESTO capo brucerebbe numeri che non sono suoi: il caso normale
        // «chi riceve rinuncia» — l'ospite chiude la scheda mentre la macchina
        // gli manda una risposta lunga — farebbe cadere ogni `open` remoto più
        // basso, cioè il contrario di ciò che il tubo promette. Il reset resta
        // accettato da tutte e due le parità: chiudere è sempre lecito.
        if (latoDiStream(f.s) === opts.latoRemoto && f.s > massimoVisto) massimoVisto = f.s;
        return { esito: "chiuso", s: f.s, motivo: f.motivo };
      }

      if (latoDiStream(f.s) !== opts.latoRemoto) return fallisci(f.s, "bad-frame");

      if (f.f === "open") {
        if (aperti.has(f.s) || f.s <= massimoVisto) return fallisci(f.s, "bad-frame");
        massimoVisto = f.s;
        if (aperti.size >= maxStream) return fallisci(f.s, "too-many-streams");
        const st: StatoStream = {
          k: f.k, ...(f.h !== undefined ? { h: f.h } : {}),
          e: null, prossimo: 1, byte: 0, testo: [], binario: [],
        };
        if (f.d !== undefined) {
          // Dati senza codifica: `leggiFrame` non lo lascerebbe passare, ma un
          // frame costruito a mano sì — e un `!` qui sarebbe una promessa che
          // non ha nessuno che la mantiene.
          if (f.e === undefined) return fallisci(f.s, "bad-frame");
          const male = accumula(st, f.e, f.d);
          if (male) return fallisci(f.s, male);
        }
        aperti.set(f.s, st);
        if (f.fin) return completa(f.s, st);
        return { esito: "aperto", s: f.s, k: f.k, ...(f.h !== undefined ? { h: f.h } : {}) };
      }

      const st = aperti.get(f.s);
      // Dati per uno stream che non è aperto: o non lo è mai stato, o era già
      // finito. In tutti e due i casi non c'è niente a cui attaccarli.
      if (!st) return fallisci(f.s, "bad-frame");
      if (f.n !== st.prossimo) return fallisci(f.s, "bad-frame");
      st.prossimo++;
      const male = accumula(st, f.e, f.d);
      if (male) return fallisci(f.s, male);
      if (f.fin) return completa(f.s, st);
      return { esito: "parziale", s: f.s, byte: st.byte };
    },
    apertiOra: () => aperti.size,
    /** Il capo se n'è andato: ciò che pendeva non arriverà mai, e tenerlo in
     *  memoria non lo fa arrivare. */
    dimentica(s: number) { aperti.delete(s); },
  };
}
