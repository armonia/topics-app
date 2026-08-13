/**
 * «Fammi vedere questo file» detto da chi NON è fidato.
 *
 * Un browser vero non decide dallo schema, decide da CHI ha chiesto la
 * navigazione: `file://` è permesso alla shell (barra indirizzi, Cmd+O,
 * drag&drop) e negato alla pagina, perché la pagina è codice altrui. L'agente
 * sta dalla parte della pagina — anzi peggio, la sua richiesta può nascere da
 * un'iniezione nel testo che ha letto — quindi per lui `file://` resta chiuso
 * (browser-tools-handler.ts, AGENT_NAV_SCHEMES) e resta chiuso il choke point
 * di ogni navigate (browser-service.ts).
 *
 * Ma "negato" non deve voler dire "non si può vedere il file": è il motivo per
 * cui questo modulo esiste. Il modo standard di mostrare un file locale a un
 * contesto non fidato è SERVIRLO su http da un'origine controllata — quello che
 * Chrome fa col suo viewer PDF, e quello che qui fa già `/api/media`, con la
 * sua allowlist di percorsi. Quindi: l'agente chiede `file:///…/x.pdf`, noi gli
 * diamo `http://127.0.0.1:<porta>/api/media?path=/…/x.pdf`. Il guard non si
 * allenta di un millimetro — la pane naviga su http come sempre — e il file si
 * vede.
 *
 * Il permesso è quello di `/api/media` e nient'altro: se il path non è nella
 * allowlist la riscrittura FALLISCE, e fallisce dicendo che il file è fuori
 * dai percorsi consentiti, non che «lo schema file: non è permesso». Il
 * messaggio giusto è metà del lavoro: era la risposta sbagliata a quella
 * domanda che lasciava una pane bianca senza spiegazione.
 */

/** Ciò che serve per decidere e comporre; iniettabile per i test. */
export interface LocalFileServing {
  /** L'allowlist di `/api/media` (la stessa, non una copia). */
  isPathAllowed: (filepath: string) => boolean;
  /** Il ripiego di `/api/media`: file dentro un progetto aperto. */
  resolveProjectPath?: (filepath: string) => string | null;
  /** Esistenza, per distinguere «non c'è» da «non si può». */
  exists?: (filepath: string) => boolean;
  /**
   * L'origine da cui il SERVER raggiunge sé stesso (es. `https://127.0.0.1:3333`).
   *
   * Non è l'unica origine in gioco, ed è il motivo per cui questo modulo
   * restituisce anche un riferimento relativo: la stessa app si serve su tre
   * porte diverse — il server in TLS su 3333, il proxy in chiaro dell'app
   * desktop su 13333, e l'host che vede un telefono in LAN. Un URL assoluto
   * cablato qui è giusto per uno solo dei tre: agli altri due arriva una porta
   * che non risponde, cioè un'altra pane bianca. Chi naviga risolve `ref` sulla
   * PROPRIA origine; questo `origin` serve solo a chi naviga dal server
   * (il pane headless).
   */
  origin: string;
}

let serving: LocalFileServing | null = null;

/**
 * Cablato una volta all'avvio (server.ts). Finché non lo è, `toServableUrl`
 * risponde `null` e ogni percorso si comporta esattamente come prima: un
 * bundle vecchio, o un test che monta mezzo server, non cambia condotta.
 */
export function setLocalFileServing(next: LocalFileServing | null): void {
  serving = next;
}

export function getLocalFileServing(): LocalFileServing | null {
  return serving;
}

/**
 * Il path locale dietro una richiesta, o `null` se la richiesta non parla di
 * file locali.
 *
 * Accetta le due forme in cui arriva davvero: `file:///Users/…` (quella che
 * l'agente scrive quando ha in mano un URL) e `/Users/…` (quella che scrive
 * quando ha in mano un path — oggi finisce in una ricerca Google, che è il modo
 * più silenzioso possibile di perdere una richiesta).
 *
 * `file://host/path` con un host che non sia `localhost` NON è nostro: è un
 * file su un'altra macchina, e fingere che sia locale sarebbe una bugia.
 */
export function localPathOf(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("/")) return decodeURIComponent(s);
  if (!/^file:/i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.hostname && u.hostname !== "localhost") return null;
  const path = decodeURIComponent(u.pathname);
  return path.startsWith("/") ? path : null;
}

export type ServableUrl =
  | {
      kind: "rewritten";
      /** Assoluto sull'origine del SERVER: per chi naviga da qui (headless). */
      url: string;
      /** Relativo: per chi ha un'origine propria (pane nativa, telefono, LAN). */
      ref: string;
      path: string;
    }
  | { kind: "not-local" }
  | { kind: "refused"; reason: string };

/** Il prefisso di ogni riferimento servito: usato anche da chi lo riconosce. */
export const MEDIA_REF_PREFIX = "/api/media?path=";

/** `true` per ciò che è uscito da qui come `ref` e va risolto su un'origine. */
export function isMediaRef(url: string): boolean {
  return url.startsWith(MEDIA_REF_PREFIX);
}

/**
 * `file:///…` (o un path assoluto) → l'URL http che serve QUEL file, se i
 * permessi di `/api/media` lo consentono.
 *
 * `not-local` per tutto il resto: chi chiama prosegue come prima, questo modulo
 * non ha voce in capitolo su http/https/about/data.
 */
export function toServableUrl(raw: string, deps: LocalFileServing | null = serving): ServableUrl {
  // Già servito: lasciarlo stare. Sulla stessa navigazione la riscrittura passa
  // due volte — la rotta open-pane la fa per poterla ANNUNCIARE alla finestra,
  // il dispatcher la rifà perché è lì che vale per tutti i rami — e al secondo
  // giro `/api/media?path=/Users/…` sembra un path assoluto: veniva rifiutato
  // come «fuori dai percorsi consentiti», che è il modo più beffardo di
  // fallire, visto che il percorso era stato appena approvato.
  if (isMediaRef(raw)) return { kind: "not-local" };
  const path = localPathOf(raw);
  if (path === null) return { kind: "not-local" };
  if (!deps) {
    return {
      kind: "refused",
      reason: `local files can't be served: this server has no media allowlist wired`,
    };
  }
  const allowed = deps.isPathAllowed(path) ? path : (deps.resolveProjectPath?.(path) ?? null);
  if (!allowed) {
    return {
      kind: "refused",
      reason:
        `"${path}" is outside the paths this server may serve. ` +
        `Local files are shown over http (/api/media), never as file:// — ` +
        `move it under an allowed media folder or open the project it belongs to.`,
    };
  }
  if (deps.exists && !deps.exists(allowed)) {
    return { kind: "refused", reason: `"${allowed}" does not exist` };
  }
  const ref = `${MEDIA_REF_PREFIX}${encodeURIComponent(allowed)}`;
  return { kind: "rewritten", url: `${deps.origin.replace(/\/$/, "")}${ref}`, ref, path: allowed };
}
