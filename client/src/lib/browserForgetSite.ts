/**
 * «Dimentica questo sito»: prima si legge cosa c'è, poi si cancella quello.
 *
 * Da quando chiudere una tab non slogga più (la chiusura toglie la cache e
 * lascia l'identità, `browserDataStoreReaper.ts`), l'unico modo per ripulire
 * davvero un sito sarebbe «chiudi e spera». Questa è la porta esplicita, e ha
 * due vincoli che vengono dall'umano e non dal codice:
 *
 *   1. DICE COSA CANCELLA PRIMA DI FARLO. Un comando distruttivo senza il nome
 *      delle cose che tocca lo si preme una volta e non lo si preme mai più.
 *   2. È PER-SITO, non un pulsante che svuota tutto.
 *
 * Il secondo vincolo è il motivo per cui il pezzo nativo che esisteva già non
 * basta: `browser_purge_data_store` rimuove lo store INTERO di un contextId, e
 * lo store è per-pane. «Questo sito» si fa un gradino sotto, sui record di
 * `WKWebsiteDataStore`: `browser_site_data_records` li elenca,
 * `browser_forget_site` rimuove quelli nominati.
 *
 * IL PATTO fra le due chiamate: si cancellano ESATTAMENTE i record che il
 * dialogo ha mostrato. Il piano porta con sé i loro `displayName` e sono quelli
 * che tornano al nativo, quindi fra il «cosa cancello» letto e il «cancella»
 * premuto non può infilarsi niente di diverso.
 *
 * Attenzione al nome: `displayName` NON è l'host della barra degli indirizzi.
 * WebKit tiene un silo per dominio registrabile, quindi su `mail.google.com` il
 * record si chiama `google.com` e vale per tutti i sottodomini. Il dialogo
 * mostra i nomi dei record e non l'host proprio per questo: cancellare la posta
 * cancella anche il resto di google.com, e va detto prima.
 */
import { tauriInvoke } from './shell/tauri';

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Un silo dello store: il nome WebKit e i tipi di dato che contiene. */
export interface SiteDataRecord {
  displayName: string;
  types: string[];
}

/** Le tre famiglie in cui si raggruppano i tipi, in ordine di gravità. */
export type SiteDataGroup = 'session' | 'storage' | 'cache';

/** Una riga dell'elenco «cosa cancello», già in italiano. */
export interface SiteDataItem {
  group: SiteDataGroup;
  label: string;
  detail: string;
}

/** Il piano: cosa si sta per cancellare, e su quali record. */
export interface ForgetSitePlan {
  /** L'host della pagina aperta, come lo legge l'utente. */
  host: string;
  /** I nomi dei record che spariranno. Sono quelli mostrati E quelli inviati. */
  displayNames: string[];
  /** Le voci leggibili. Vuoto = per questo sito non c'è niente da dimenticare. */
  items: SiteDataItem[];
}

/**
 * Tipo di dato WebKit → famiglia. Le chiavi le decide il Rust
 * (`site_data_type_key`), che le ricava dai simboli del framework.
 */
const GROUP_BY_TYPE: Record<string, SiteDataGroup> = {
  cookies: 'session',
  localStorage: 'storage',
  sessionStorage: 'storage',
  indexedDB: 'storage',
  webSql: 'storage',
  diskCache: 'cache',
  memoryCache: 'cache',
  fetchCache: 'cache',
  offlineAppCache: 'cache',
  serviceWorkers: 'cache',
};

/** Un tipo che non conosciamo è comunque roba del sito: nel mucchio dei dati. */
const FALLBACK_GROUP: SiteDataGroup = 'storage';

const GROUP_ORDER: SiteDataGroup[] = ['session', 'storage', 'cache'];

const GROUP_COPY: Record<SiteDataGroup, { label: string; detail: string }> = {
  session: { label: 'Sessione e cookie', detail: 'Al prossimo caricamento sei sloggato.' },
  storage: { label: 'Dati del sito', detail: 'localStorage e IndexedDB: preferenze, bozze, roba offline.' },
  cache: { label: 'Cache', detail: 'File temporanei. Si riscaricano da soli.' },
};

/**
 * L'host di una pagina, o null se non c'è un sito da dimenticare (about:blank,
 * data:, un file locale). Il `www.` iniziale se ne va: nessun record WebKit si
 * chiama così, e nel titolo del dialogo è rumore.
 */
export function siteHostOf(url: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return host || null;
}

/**
 * I record che riguardano `host`, in tutte e due le direzioni della parentela:
 * il silo registrabile che lo contiene (`google.com` per `mail.google.com`) e i
 * siloni più specifici che stanno sotto di lui. Il resto dello store non si
 * tocca: è il vincolo «per-sito».
 */
export function matchSiteRecords(records: SiteDataRecord[], host: string): SiteDataRecord[] {
  const target = host.toLowerCase().replace(/^www\./, '');
  if (!target) return [];
  return records.filter((rec) => {
    const name = (rec.displayName || '').toLowerCase();
    if (!name) return false;
    return name === target || target.endsWith(`.${name}`) || name.endsWith(`.${target}`);
  });
}

/**
 * L'elenco leggibile dei record: una riga per famiglia presente, nell'ordine in
 * cui pesano. Niente record, nessuna riga: il dialogo deve poter dire «qui non
 * c'è niente» invece di elencare cose che non esistono.
 */
export function describeSiteData(records: SiteDataRecord[]): SiteDataItem[] {
  const present = new Set<SiteDataGroup>();
  for (const rec of records) {
    for (const type of rec.types ?? []) {
      present.add(GROUP_BY_TYPE[type] ?? FALLBACK_GROUP);
    }
  }
  return GROUP_ORDER.filter((g) => present.has(g)).map((group) => ({ group, ...GROUP_COPY[group] }));
}

/** I nomi dei record, senza doppioni e in ordine: la lista che si mostra. */
export function siteRecordNames(records: SiteDataRecord[]): string[] {
  return [...new Set(records.map((r) => r.displayName).filter(Boolean))].sort();
}

function parseRecords(raw: string): SiteDataRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const rec = entry as { displayName?: unknown; types?: unknown };
    if (typeof rec?.displayName !== 'string' || !rec.displayName) return [];
    const types = Array.isArray(rec.types) ? rec.types.filter((t): t is string => typeof t === 'string') : [];
    return [{ displayName: rec.displayName, types }];
  });
}

/**
 * Cosa sparirebbe se si dimenticasse il sito aperto in questa pane. `null` =
 * non c'è un sito (pane vuota, pagina non http). Lo store non viene toccato:
 * questa chiamata legge e basta.
 */
export async function planForgetSite(
  contextId: string,
  url: string,
  invoke: Invoke = tauriInvoke,
): Promise<ForgetSitePlan | null> {
  const host = siteHostOf(url);
  if (!host) return null;
  let records: SiteDataRecord[] = [];
  try {
    records = parseRecords(await invoke<string>('browser_site_data_records', { id: contextId }));
  } catch {
    // Store illeggibile: il piano resta vuoto e il dialogo lo dice, invece di
    // offrire un tasto che promette di cancellare qualcosa che non ha visto.
    return { host, displayNames: [], items: [] };
  }
  const mine = matchSiteRecords(records, host);
  return { host, displayNames: siteRecordNames(mine), items: describeSiteData(mine) };
}

/**
 * Esegue il piano: rimuove i record nominati e ritorna quanti ne ha tolti.
 * Prende la lista, non l'host, perché la cosa cancellata dev'essere la stessa
 * che è stata letta.
 */
export async function forgetSite(
  contextId: string,
  displayNames: string[],
  invoke: Invoke = tauriInvoke,
): Promise<number> {
  if (displayNames.length === 0) return 0;
  return await invoke<number>('browser_forget_site', { id: contextId, displayNames });
}
