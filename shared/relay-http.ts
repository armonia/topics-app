/**
 * Una richiesta HTTP dentro il tubo: la testa, e cosa se ne accetta.
 *
 * ── PERCHÉ NON DENTRO `relay-protocol.ts` ───────────────────────────────────
 * Il tubo trasporta e non interpreta: `k` (il genere) e `h` (la testa) sono
 * stringhe opache, e devono restarlo — il giorno in cui il trasporto sa che
 * dentro c'è un metodo e un percorso, ha una descrizione del traffico che non
 * gli spetta. Questo modulo è lo strato SOPRA: sa che `k: "req"` porta una
 * richiesta e `k: "res"` la sua risposta, e nessuno strato sotto lo sa.
 *
 * ── PERCHÉ NON DENTRO IL CLIENT DELLA MACCHINA ──────────────────────────────
 * Perché i capi sono due. Un formato che vive dentro uno dei due capi non è un
 * formato: è il comportamento di quel capo, e l'altro lo insegue. Sta in
 * `shared/` per la stessa ragione per cui ci sta `relay-protocol.ts`.
 *
 * ── LA REGOLA CHE GOVERNA OGNI SCELTA QUI ───────────────────────────────────
 * Chi manda queste teste è FUORI dalla rete di casa, e ciò che scrive non vale
 * più di un'affermazione. Quindi ogni campo si legge in modo stretto e ogni
 * intestazione passa da una lista: le due cose che si possono sbagliare qui
 * sono lasciar scegliere all'ospite DOVE si rigioca la richiesta (e allora la
 * macchina diventa un ponte verso il resto della rete) e lasciargli dichiarare
 * CHI è (e allora il tetto per-indirizzo dell'appaiamento non conta più).
 */

/** Il genere dello stream che porta una richiesta. */
export const GENERE_RICHIESTA = "req";
/** …e quello che porta la sua risposta. */
export const GENERE_RISPOSTA = "res";

/** Le intestazioni come COPPIE e non come oggetto: `set-cookie` compare più
 *  volte, e un oggetto ne terrebbe una sola — cioè perderebbe esattamente
 *  quella che fa entrare un dispositivo appaiato. */
export type Intestazioni = [string, string][];

/** La testa di una richiesta, dentro `h` dello stream `req`. */
export interface TestaRichiesta {
  /** Metodo, in maiuscolo. */
  m: string;
  /** Percorso e query, sempre a partire da `/`. Mai un URL assoluto: dove si
   *  rigioca lo decide la macchina, non chi chiede. */
  p: string;
  h?: Intestazioni;
  /**
   * L'indirizzo VERO di chi ha bussato, messo dal RELAY.
   *
   * Sta nella testa e non in un'intestazione perché le intestazioni di
   * inoltro (`x-forwarded-for`, `cf-connecting-ip`) le spoglia
   * `VIETATE_RICHIESTA` a ragione: chi bussa può scriversele da sé. Il relay
   * invece compone questa testa, e l'ospite non la tocca.
   *
   * Senza, l'unico indirizzo che la macchina vede è `127.0.0.1` — il suo
   * stesso salto locale. Due conseguenze, entrambe viste in produzione: il
   * tetto per-indirizzo dell'appaiamento diventa UN SOLO secchio per tutta
   * Internet (tre richieste e non si appaia più nessuno, proprietario
   * compreso), e il cartello di approvazione dichiara «viene dalla tua
   * macchina» a una richiesta arrivata da fuori — che è la bugia più
   * pericolosa possibile, perché rassicura.
   */
  ip?: string;
}

/** La testa di una risposta, dentro `h` dello stream `res`. */
export interface TestaRisposta {
  /** Lo stream della richiesta a cui questa risposta appartiene.
   *
   *  Serve perché la risposta NON può viaggiare sullo stesso numero: i numeri
   *  pari sono della macchina e i dispari dell'ospite (`latoDiStream`), e un
   *  capo che riceve un numero della propria parità lo rifiuta. Quindi la
   *  risposta apre uno stream suo e si dichiara figlia di quello. */
  re: number;
  /** Lo stato HTTP, così com'è tornato: 302 e 404 sono risposte, non guasti. */
  s: number;
  h?: Intestazioni;
}

/**
 * I metodi che si rigiocano.
 *
 * Lista chiusa e non «tutto ciò che è un token»: `CONNECT` chiederebbe alla
 * macchina di aprire un tunnel verso altro, e `TRACE` rimanda indietro la
 * richiesta così com'è — che è il modo classico per farsi leggere intestazioni
 * che non si potevano leggere.
 */
const METODI = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Quante intestazioni si accettano, e quanto possono essere lunghe. Senza un
 *  tetto, la testa di uno stream è memoria che chiunque può far crescere. */
const MAX_INTESTAZIONI = 100;
const MAX_NOME = 256;
const MAX_VALUE = 8 * 1024;
const MAX_TESTA = 16 * 1024;

/** Un nome di intestazione secondo la grammatica dei token HTTP. Tutto il
 *  resto — spazi, due punti, ritorni a capo — è ciò con cui si spezza in due
 *  una richiesta a valle. */
const VALID_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * C'è un carattere di controllo qui dentro?
 *
 * Scritto come ciclo e non come espressione regolare di proposito: una classe
 * di caratteri di controllo si scrive con sequenze di escape che qualunque
 * strumento a valle può normalizzare in BYTE veri dentro il sorgente — e un
 * byte nullo nel sorgente è invisibile a `grep`, quindi a chiunque cerchi.
 * Il tab (9) è lecito in un valore di intestazione e resta fuori.
 */
function haControlli(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 9) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/**
 * Le intestazioni che NON si inoltrano alla macchina.
 *
 * Due famiglie, con due motivi diversi.
 *
 * Le prime sono di SALTO: descrivono la connessione fra due capi vicini, e
 * questa connessione non è quella. Inoltrarle vuol dire raccontare a valle una
 * cosa che non è vera (`content-length` di un corpo che è stato rimesso
 * insieme altrove, `transfer-encoding` di un trasporto che non c'è).
 *
 * Le seconde sono le dichiarazioni di INDIRIZZO. `clientIpOf` le legge — e le
 * legge apposta SOLO per ciò che entra dalla porta del tunnel — per sapere chi
 * sta bussando, e da quel numero dipende il tetto di tre tentativi
 * sull'appaiamento. Lasciare che sia l'ospite a scriverle significa lasciargli
 * scegliere il proprio secchio: un indirizzo nuovo a ogni tentativo, e il tetto
 * non esiste più. Si tolgono e non si sostituiscono con un'invenzione: il vero
 * indirizzo dell'ospite di qua non si sa, e un numero inventato sarebbe un
 * numero che qualcuno un giorno legge come vero.
 */
const VIETATE_RICHIESTA = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authenticate", "proxy-authorization", "host", "content-length", "expect",
  "cf-connecting-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
]);

/**
 * Le intestazioni che non si rimandano indietro.
 *
 * Oltre a quelle di salto c'è `content-encoding`, ed è il caso che morde: la
 * `fetch` consegna il corpo GIÀ decompresso, quindi mandare avanti
 * l'intestazione direbbe all'ospite di scompattare una seconda volta qualcosa
 * che è già testo. `content-length` per lo stesso motivo: la misura è quella
 * del corpo compresso, e non corrisponde più a ciò che parte.
 */
const FORBIDDEN_REPLY = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authenticate", "proxy-authorization", "content-encoding", "content-length",
]);

function pulisci(h: Intestazioni, vietate: Set<string>): Intestazioni {
  const out: Intestazioni = [];
  for (const [n, v] of h) {
    if (out.length >= MAX_INTESTAZIONI) break;
    const nome = n.toLowerCase();
    if (!VALID_NAME.test(nome) || nome.length > MAX_NOME) continue;
    if (vietate.has(nome)) continue;
    if (v.length > MAX_VALUE || haControlli(v)) continue;
    out.push([nome, v]);
  }
  return out;
}

/** Ciò che di una richiesta dell'ospite si consegna alla macchina. */
export function intestazioniRichiesta(h: Intestazioni | undefined): Intestazioni {
  return pulisci(h ?? [], VIETATE_RICHIESTA);
}

/** …e ciò che della risposta torna indietro. */
export function intestazioniRisposta(h: Intestazioni): Intestazioni {
  return pulisci(h, FORBIDDEN_REPLY);
}

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

/**
 * Dove si rigioca una richiesta, o `null`.
 *
 * È il cancello che tiene la macchina un capo e non un PONTE. `p` deve essere
 * un percorso e basta: un URL assoluto, un `//altro-host` (che il parser legge
 * come «stesso schema, altro host») o una barra rovesciata — che alcuni parser
 * normalizzano in barra — sceglierebbero un'altra destinazione. Si controlla
 * la forma PRIMA e l'origine DOPO: la seconda da sola non basta, perché
 * `new URL` ne normalizza troppa di quella roba senza dire niente.
 */
/**
 * Un indirizzo che si può ACCETTARE da un altro processo.
 *
 * Stretto di proposito: questo valore finisce in un tetto e su un cartello che
 * l'umano legge per decidere. Una stringa qualunque lì dentro è un modo di
 * scrivere nell'interfaccia di chi approva.
 */
export function ipAccettabile(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split(".").every((o) => Number(o) <= 255);
  }
  // IPv6, anche nella forma mappata `::ffff:1.2.3.4`.
  return /^[0-9a-fA-F:]+(\.\d{1,3}){0,3}$/.test(v) && v.includes(":");
}

export function risolviUrlLocale(porta: number, p: string, tls = false): URL | null {
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) return null;
  if (typeof p !== "string" || p.length === 0 || p.length > 8 * 1024) return null;
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  // Spazi, barre rovesciate e caratteri di controllo: nessuno di questi
  // appartiene a un percorso, e ognuno è un modo per farlo leggere diverso a
  // due parser diversi.
  if (/[\s\\]/.test(p) || haControlli(p)) return null;
  // Lo SCHEMA segue quello dell'ascoltatore, e non è cablato.
  //
  // La porta del tunnel eredita `opzioniServer`, TLS compreso: su un'installazione
  // con i certificati `http://127.0.0.1:<porta>` non risponde affatto, e il ponte
  // restituiva `upstream-unreachable` a ogni richiesta. Misurato in produzione:
  // `http` → connessione rifiutata, `https` → 401 (cioè il server, che chiede
  // un'identità perché chi entra da lì non è locale).
  //
  // E non si risolve parlando in chiaro: `secure` del biscotto di sessione
  // discende da `url.protocol` (server/routes/auth.ts), quindi un tratto locale
  // in chiaro conierebbe un biscotto SENZA `Secure` per una sessione che viaggia
  // su un'origine pubblica in HTTPS. Il tratto locale non deve poter decidere un
  // attributo di sicurezza del tratto pubblico.
  const base = `${tls ? "https" : "http"}://127.0.0.1:${porta}`;
  try {
    const u = new URL(p, base);
    return u.origin === base ? u : null;
  } catch {
    return null;
  }
}

/** La testa di una richiesta, letta in modo stretto. `null` = non si prova
 *  lo stesso: questo arriva da fuori. */
export function leggiTestaRichiesta(raw: string | undefined): TestaRichiesta | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TESTA) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const m = o as Record<string, unknown>;
  if (typeof m.m !== "string" || !METODI.has(m.m)) return null;
  if (typeof m.p !== "string") return null;
  const h = "h" in m && m.h !== undefined ? leggiIntestazioni(m.h) : undefined;
  if (h === null) return null;
  // Un `ip` che non è un indirizzo si SCARTA invece di far fallire tutta la
  // testa: una richiesta valida non deve morire perché il relay ha mandato un
  // campo storto, e un campo storto non deve entrare.
  return {
    m: m.m, p: m.p,
    ...(h !== undefined ? { h } : {}),
    ...(ipAccettabile(m.ip) ? { ip: m.ip } : {}),
  };
}

/** La testa di una risposta, letta con la stessa severità: anche la macchina,
 *  vista dall'ospite, è un capo remoto. */
export function leggiTestaRisposta(raw: string | undefined): TestaRisposta | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TESTA) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const m = o as Record<string, unknown>;
  if (typeof m.re !== "number" || !Number.isInteger(m.re) || m.re < 0) return null;
  if (typeof m.s !== "number" || !Number.isInteger(m.s) || m.s < 100 || m.s > 599) return null;
  const h = "h" in m && m.h !== undefined ? leggiIntestazioni(m.h) : undefined;
  if (h === null) return null;
  return { re: m.re, s: m.s, ...(h !== undefined ? { h } : {}) };
}

/** Una testa pronta per `h`. Una funzione e non uno `JSON.stringify` sparso,
 *  così il posto dove la testa diventa stringa è UNO. */
export function scriviTesta(t: TestaRichiesta | TestaRisposta): string {
  return JSON.stringify(t);
}
