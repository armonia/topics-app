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
 *
 * DUE POSTI, UN DIALOGO SOLO. La stessa pane esiste in due incarnazioni: la
 * WKWebView privata di questo Mac e la sessione CONDIVISA che gira sul browser
 * del server (quella che il telefono vede). Sono due magazzini diversi, con due
 * modi di nominare i silo, ma la domanda dell'utente è una: «togli questo sito
 * da questa scheda». Quindi il piano, l'elenco e il patto stanno qui una volta
 * sola, e quello che cambia è solo il `SiteDataBackend` che li alimenta.
 */
import { tauriInvoke } from './shell/tauri';

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Un silo dello store: il nome del silo e i tipi di dato che contiene. Il nome
 *  lo scrive chi tiene i dati, e i due magazzini lo scrivono diverso (WebKit per
 *  dominio registrabile, il condiviso per host preciso): la FORMA però è una
 *  sola, e sta in `shared/` perché il server la produce e il client la legge. */
export type { SiteDataRecord } from '../../../shared/browser-site-record';
import type { SiteDataRecord } from '../../../shared/browser-site-record';

/**
 * Da dove arrivano i silo e chi li cancella. Le due implementazioni sono
 * `nativeSiteData` (WKWebsiteDataStore, solo Tauri) e `sharedSiteData` (lo
 * `storageState` del contesto Playwright sul server).
 *
 * `records()` torna TUTTI i record del contesto, non solo quelli del sito: il
 * filtro per host è `matchSiteRecords` e sta qui sopra, uguale per tutti e due.
 * Un backend che filtrasse per conto suo sarebbe una seconda regola da tenere
 * allineata alla prima, ed è il tipo di divergenza che nessuno nota finché non
 * cancella la cosa sbagliata.
 */
export interface SiteDataBackend {
  /** `supported:false` = questo magazzino esiste ma non è nostro (il profilo di
   *  un Chromium esterno): il dialogo lo dice invece di elencare zero record e
   *  far credere che non ci sia niente da dimenticare. */
  records(contextId: string): Promise<{ supported: boolean; records: SiteDataRecord[] }>;
  /** Rimuove i silo NOMINATI e ritorna quanti ne ha tolti. */
  forget(contextId: string, displayNames: string[]): Promise<number>;
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
  /** `false` = i dati di questa pane non li teniamo noi, quindi da qui non si
   *  cancellano. Diverso da «non c'è niente»: il dialogo dice cose diverse. */
  supported: boolean;
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

/** Normalizza una lista di record da qualunque provenienza (JSON del nativo,
 *  corpo della risposta HTTP): scarta ciò che non ha un nome. */
function parseRecords(data: unknown): SiteDataRecord[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const rec = entry as { displayName?: unknown; types?: unknown };
    if (typeof rec?.displayName !== 'string' || !rec.displayName) return [];
    const types = Array.isArray(rec.types) ? rec.types.filter((t): t is string => typeof t === 'string') : [];
    return [{ displayName: rec.displayName, types }];
  });
}

/**
 * La WKWebView privata di questo Mac. I nomi sono quelli di WebKit, cioè per
 * dominio registrabile: `google.com` anche quando sei su `mail.google.com`.
 * Il nativo risponde con una stringa JSON, non con un array.
 */
export function nativeSiteData(invoke: Invoke = tauriInvoke): SiteDataBackend {
  return {
    async records(contextId) {
      const raw = await invoke<string>('browser_site_data_records', { id: contextId });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      return { supported: true, records: parseRecords(parsed) };
    },
    async forget(contextId, displayNames) {
      return await invoke<number>('browser_forget_site', { id: contextId, displayNames });
    },
  };
}

/**
 * La sessione CONDIVISA: il contesto Playwright del server e il suo
 * `storage.json`. Qui i nomi sono PRECISI (dominio del cookie senza il punto
 * iniziale, hostname dell'origin), quindi `mail.google.com` è un silo suo e si
 * vede nell'elenco accanto a `google.com` invece di sparirci dentro.
 *
 * Manca una famiglia rispetto al nativo, ed è voluto: la cache HTTP del
 * browser del server non è per-sito, quindi non compare fra i tipi e il
 * dialogo non la promette.
 */
export function sharedSiteData(): SiteDataBackend {
  const base = (contextId: string) => `/api/browsers/${encodeURIComponent(contextId)}`;
  return {
    async records(contextId) {
      const res = await fetch(`${base(contextId)}/site-data`);
      if (!res.ok) throw new Error(`site-data ${res.status}`);
      const body = (await res.json()) as { supported?: unknown; records?: unknown };
      return { supported: body?.supported !== false, records: parseRecords(body?.records) };
    },
    async forget(contextId, displayNames) {
      const res = await fetch(`${base(contextId)}/forget-site`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayNames }),
      });
      if (!res.ok) throw new Error(`forget-site ${res.status}`);
      const body = (await res.json()) as { removed?: unknown };
      return typeof body?.removed === 'number' ? body.removed : 0;
    },
  };
}

/**
 * Cosa sparirebbe se si dimenticasse il sito aperto in questa pane. `null` =
 * non c'è un sito (pane vuota, pagina non http). Lo store non viene toccato:
 * questa chiamata legge e basta.
 */
export async function planForgetSite(
  contextId: string,
  url: string,
  backend: SiteDataBackend,
): Promise<ForgetSitePlan | null> {
  const host = siteHostOf(url);
  if (!host) return null;
  let answer: { supported: boolean; records: SiteDataRecord[] };
  try {
    answer = await backend.records(contextId);
  } catch {
    // Store illeggibile: il piano resta vuoto e il dialogo lo dice, invece di
    // offrire un tasto che promette di cancellare qualcosa che non ha visto.
    return { host, displayNames: [], items: [], supported: true };
  }
  if (!answer.supported) return { host, displayNames: [], items: [], supported: false };
  const mine = matchSiteRecords(answer.records, host);
  return { host, displayNames: siteRecordNames(mine), items: describeSiteData(mine), supported: true };
}

/**
 * Esegue il piano: rimuove i record nominati e ritorna quanti ne ha tolti.
 * Prende la lista, non l'host, perché la cosa cancellata dev'essere la stessa
 * che è stata letta.
 */
export async function forgetSite(
  contextId: string,
  displayNames: string[],
  backend: SiteDataBackend,
): Promise<number> {
  if (displayNames.length === 0) return 0;
  return await backend.forget(contextId, displayNames);
}
