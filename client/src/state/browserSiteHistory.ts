/**
 * browserSiteHistory — lo storico GLOBALE dei siti visitati nel browser
 * dell'app, cioè la materia prima della pagina Nuovo Tab.
 *
 * Non sostituisce `useBrowserHistory`, che è un'altra cosa: quello è l'elenco
 * degli indirizzi di UNA pane (il menu a tendina della toolbar), per-topic e
 * ordinato per ultima visita. Qui invece si tiene UNA voce per SITO, valida per
 * tutta l'app, con quante volte ci si è passati e quando. È la differenza fra
 * «dove sono stato in questa scheda» e «quali sono i miei siti».
 *
 * Perché per host e non per pagina: le griglie dei siti più visitati che
 * funzionano mostrano otto DESTINAZIONI diverse. Tenendo le pagine, chi lavora
 * su una issue vedrebbe otto riquadri dello stesso dominio, che è un elenco
 * inutile con l'aspetto di una griglia. Della pagina si conserva comunque
 * l'ultimo indirizzo visitato del sito, che è quello su cui il riquadro porta.
 *
 * ORDINAMENTO (frecency): visite pesate dalla freschezza, come in Firefox. Il
 * solo conteggio incorona per mesi un sito abbandonato la settimana scorsa; la
 * sola recenza fa ballare la griglia a ogni visita di passaggio. I pesi stanno
 * in `RECENCY_WEIGHTS`, a scaglioni: sono una scelta, non una formula continua,
 * e a scaglioni si legge cosa succede a un sito che non si apre da un mese.
 *
 * Magazzino: localStorage (una chiave sola, tutta l'app). Con storage assente o
 * pieno lo store resta in memoria e l'interfaccia funziona lo stesso.
 *
 * TWO VIEWS, ONE SOURCE. Next to the sites this module also keeps the list
 * of visited PAGES, in time order: it is the "history" in the sense a
 * browser means it, and it is the navigation counterpart of the history of
 * closed tabs (`closedTabRecord`). The two lists are born of the same call
 * (`recordSiteVisit`), and that is the point: a second entry point would
 * mean one path that records the visit and another one that forgets it,
 * that is to say two histories that contradict each other. The site answers
 * "which sites are mine", the page answers "where have I been", and whoever
 * deletes a site carries both of them away.
 */

import { siteHostOf } from '../lib/browserForgetSite';

export interface SiteEntry {
  /** L'host, chiave della voce. Minuscolo, senza `www.`. */
  host: string;
  /** L'ultimo indirizzo visitato su questo sito: è dove porta il riquadro. */
  url: string;
  /** Titolo dell'ultima pagina vista lì. Può essere vuoto. */
  title: string;
  /** Favicon dichiarata dall'ultima pagina vista lì. Può essere vuota. */
  favicon: string;
  /** Quante visite distinte (vedi `VISIT_DEDUPE_MS`). */
  visits: number;
  /** Epoch ms dell'ultima visita. */
  lastVisit: number;
}

/** A visited PAGE: one row of the navigation history. */
export interface PageVisit {
  /** The full URL: nothing is aggregated by host here, you get back where you were. */
  url: string;
  /** Title of the page, once it arrived. May be empty. */
  title: string;
  /** Favicon declared by the page. May be empty. */
  favicon: string;
  /** Epoch ms of the visit. */
  at: number;
}

const STORAGE_KEY = 'topics:browser-sites:v1';
const PAGES_KEY = 'topics:browser-pages:v1';

/** How many pages are kept. More than the sites (which are destinations) and
 *  far fewer than a real browser history: this list is here to find again
 *  what you opened in these days, not to run an archive search over it. */
export const MAX_PAGES = 200;

/** Quanti siti si conservano. Oltre, esce quello con la frecency più bassa: la
 *  griglia ne mostra otto, ma un magazzino più largo lascia risalire un sito
 *  usato a ondate invece di dimenticarlo fra un'ondata e l'altra. */
export const MAX_SITES = 120;

/** Due visite allo STESSO indirizzo entro questa finestra contano una volta.
 *  Un ricarico, un ⌘R, o il ritorno indietro-avanti non sono affetto per un
 *  sito: sono la stessa visita. Un indirizzo DIVERSO sullo stesso host conta
 *  sempre (navigare dentro un sito è usarlo). */
export const VISIT_DEDUPE_MS = 30_000;

const DAY_MS = 86_400_000;

/** Peso della freschezza, a scaglioni di età dell'ultima visita. */
const RECENCY_WEIGHTS: ReadonlyArray<{ withinDays: number; weight: number }> = [
  { withinDays: 1, weight: 100 },
  { withinDays: 4, weight: 70 },
  { withinDays: 14, weight: 50 },
  { withinDays: 31, weight: 30 },
  { withinDays: 90, weight: 10 },
];
/** Oltre l'ultimo scaglione: non zero, o un sito vecchissimo e visitatissimo
 *  sparirebbe sotto uno aperto una volta sola. */
const STALE_WEIGHT = 1;

let sites: SiteEntry[] = load();
let pages: PageVisit[] = loadPages();
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): SiteEntry[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function loadPages(): PageVisit[] {
  try {
    const raw = storage()?.getItem(PAGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPage);
  } catch {
    return [];
  }
}

function isPage(v: unknown): v is PageVisit {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<PageVisit>;
  return typeof e.url === 'string' && !!e.url && typeof e.at === 'number';
}

function isEntry(v: unknown): v is SiteEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<SiteEntry>;
  return typeof e.host === 'string' && !!e.host
    && typeof e.url === 'string'
    && typeof e.visits === 'number'
    && typeof e.lastVisit === 'number';
}

function persist(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(sites));
  } catch {
    /* quota piena o storage spento: la copia in memoria basta a questa sessione */
  }
}

function persistPages(): void {
  try {
    storage()?.setItem(PAGES_KEY, JSON.stringify(pages));
  } catch {
    /* as above: with no store the current session works just the same */
  }
}

/**
 * One single write for the two lists, and one single round of notifications.
 *
 * `nextPages` absent means "the pages do not change": it avoids rewriting an
 * identical list to disk (that is the case of `noteSiteMeta` when the page is
 * no longer the one on top).
 */
function commit(next: SiteEntry[], nextPages?: PageVisit[]): void {
  sites = next;
  persist();
  if (nextPages) {
    pages = nextPages;
    persistPages();
  }
  for (const fn of listeners) fn();
}

/**
 * La chiave di una voce: l'host, o stringa vuota se quell'indirizzo non è un
 * sito. Fuori restano `about:blank`, le pagine d'errore di WebKit e tutto ciò
 * che non è http(s): un file locale o una schermata interna non sono una
 * destinazione che si vuole rivedere in griglia.
 *
 * La regola dell'host (minuscolo, senza `www.`) è la stessa di «Dimentica
 * questo sito», e viene da lì: due definizioni di sito nello stesso browser
 * vorrebbero dire una griglia che nomina un dominio e un dialogo che ne
 * cancella un altro.
 */
export function siteKeyOf(url: string): string {
  return siteHostOf(url) ?? '';
}

/** Il punteggio di ordinamento: visite per il peso della freschezza. */
export function frecency(entry: SiteEntry, now: number): number {
  const ageDays = Math.max(0, now - entry.lastVisit) / DAY_MS;
  const bucket = RECENCY_WEIGHTS.find((b) => ageDays < b.withinDays);
  return entry.visits * (bucket ? bucket.weight : STALE_WEIGHT);
}

/**
 * Registra una visita. Chiamata a ogni cambio di indirizzo di una pane.
 *
 * Il conteggio sale solo per una visita NUOVA (indirizzo diverso, o stesso
 * indirizzo ma passata la finestra di dedup): `lastVisit` invece si aggiorna
 * sempre, perché il sito è stato comunque usato adesso.
 */
export function recordSiteVisit(url: string, now: number = Date.now()): void {
  const host = siteKeyOf(url);
  if (!host) return;
  const prev = sites.find((s) => s.host === host);
  const fresh = !prev || prev.url !== url || now - prev.lastVisit >= VISIT_DEDUPE_MS;
  const entry: SiteEntry = prev
    ? { ...prev, url, visits: prev.visits + (fresh ? 1 : 0), lastVisit: now }
    : { host, url, title: '', favicon: '', visits: 1, lastVisit: now };
  const next = [entry, ...sites.filter((s) => s.host !== host)];
  // The HISTORY row follows the same dedupe rule as the visit: a ⌘R, or a
  // back and forward, must not leave three identical rows one under the other.
  // When it is not a new visit the timestamp of the row on top is updated in
  // place, because that row is the same page.
  const head = pages[0];
  const sameHead = head && head.url === url;
  const nextPages = fresh || !sameHead
    ? [
        { url, title: prev && prev.url === url ? prev.title : '', favicon: prev && prev.url === url ? prev.favicon : '', at: now },
        ...pages.filter((p) => p.url !== url),
      ].slice(0, MAX_PAGES)
    : [{ ...head, at: now }, ...pages.slice(1)];
  commit(next.length > MAX_SITES ? evict(next, now) : next, nextPages);
}

/**
 * Titolo e favicon dell'ultima pagina vista sul sito. Arrivano DOPO l'indirizzo
 * (il titolo lo dà la pagina a caricamento avviato), quindi sono una scrittura
 * a parte: non è una visita e non tocca né il conteggio né `lastVisit`.
 */
export function noteSiteMeta(url: string, meta: { title?: string; favicon?: string }): void {
  const host = siteKeyOf(url);
  if (!host) return;
  const prev = sites.find((s) => s.host === host);
  if (!prev || prev.url !== url) return;
  const title = meta.title ?? prev.title;
  const favicon = meta.favicon ?? prev.favicon;
  if (title === prev.title && favicon === prev.favicon) return;
  // Title and icon hold for the history row of THAT page too, which without
  // them would stay a naked URL in a list of names.
  const nextPages = pages.some((p) => p.url === url && (p.title !== title || p.favicon !== favicon))
    ? pages.map((p) => (p.url === url ? { ...p, title, favicon } : p))
    : undefined;
  commit(sites.map((s) => (s.host === host ? { ...s, title, favicon } : s)), nextPages);
}

/** Toglie il sito dallo storico: è il gesto del riquadro che non si vuole più
 *  vedere. Torna `true` se c'era qualcosa da togliere. */
export function forgetSite(host: string): boolean {
  const hadPages = pages.some((p) => siteKeyOf(p.url) === host);
  if (!sites.some((s) => s.host === host) && !hadPages) return false;
  // Forgetting a site carries away its PAGES too: leaving them would mean a
  // gesture that promises to erase and erases by halves, with the URL popping
  // back up in the row below.
  commit(
    sites.filter((s) => s.host !== host),
    hadPages ? pages.filter((p) => siteKeyOf(p.url) !== host) : undefined,
  );
  return true;
}

/**
 * I siti in ordine di frecency, i migliori per primi.
 *
 * Prende l'elenco invece di leggerlo da qui dentro: chi la chiama in React lo ha
 * già in mano (`useSyncExternalStore`), e passarglielo rende il riordino una
 * funzione della sola istantanea, quindi memoizzabile su quella.
 */
export function rankSites(entries: readonly SiteEntry[], limit = 8, now: number = Date.now()): SiteEntry[] {
  return [...entries]
    .sort((a, b) => frecency(b, now) - frecency(a, now) || b.lastVisit - a.lastVisit)
    .slice(0, Math.max(0, limit));
}

function evict(list: SiteEntry[], now: number): SiteEntry[] {
  return rankSites(list, MAX_SITES, now);
}

/** Per `useSyncExternalStore`: identità stabile finché non si scrive. */
export function sitesSnapshot(): SiteEntry[] {
  return sites;
}

/** The visited pages, most recent first. Stable identity, as above. */
export function pagesSnapshot(): PageVisit[] {
  return pages;
}

/** Empties the navigation history and leaves the sites standing (the new tab
 *  page grid): they are two different promises, and whoever erases "where I
 *  have been" is not asking to forget their own sites. */
export function clearPageHistory(): void {
  if (pages.length === 0) return;
  commit(sites, []);
}

export function subscribeSites(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Solo per i test. */
export function __resetSiteHistory(): void {
  sites = [];
  pages = [];
  try {
    storage()?.removeItem(STORAGE_KEY);
    storage()?.removeItem(PAGES_KEY);
  } catch {
    /* niente storage: lo stato in memoria è già azzerato */
  }
}
