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

const STORAGE_KEY = 'topics:browser-sites:v1';

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

function commit(next: SiteEntry[]): void {
  sites = next;
  persist();
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
  commit(next.length > MAX_SITES ? evict(next, now) : next);
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
  commit(sites.map((s) => (s.host === host ? { ...s, title, favicon } : s)));
}

/** Toglie il sito dallo storico: è il gesto del riquadro che non si vuole più
 *  vedere. Torna `true` se c'era qualcosa da togliere. */
export function forgetSite(host: string): boolean {
  if (!sites.some((s) => s.host === host)) return false;
  commit(sites.filter((s) => s.host !== host));
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

export function subscribeSites(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Solo per i test. */
export function __resetSiteHistory(): void {
  sites = [];
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* niente storage: lo stato in memoria è già azzerato */
  }
}
