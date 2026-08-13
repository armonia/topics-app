/**
 * «Dimentica questo sito» sulla pane CONDIVISA: i silo di identità, letti e
 * tolti dallo `storageState` di Playwright.
 *
 * Sul nativo l'elenco lo dà WebKit (`WKWebsiteDataStore`), e i suoi record
 * portano il nome del DOMINIO REGISTRABILE: su `mail.google.com` il silo si
 * chiama `google.com` e vale per tutti i sottodomini. Qui l'inventario è un
 * altro: il servizio salva `storageState({ indexedDB: true })`, cioè una lista
 * di cookie e una lista di origin. Sono nomi PRECISI, non raggruppati, quindi
 * il dialogo può dire esattamente cosa sparisce invece di dover avvertire che
 * si porta via anche i vicini.
 *
 * Due regole di nomenclatura, ed è tutto il modulo:
 *
 *   COOKIE   il silo è il `domain` senza il punto iniziale. `.github.com` e
 *            `github.com` sono lo stesso barattolo scritto in due modi, e
 *            tenerli distinti farebbe comparire due righe per una cosa sola.
 *   ORIGIN   il silo è l'hostname. `https://app.foo.io` e `http://app.foo.io`
 *            finiscono nello stesso nome: quello che l'utente legge nella barra
 *            degli indirizzi è l'host, non lo schema.
 *
 * Il `www.` NON si toglie: `www.example.com` è davvero un altro barattolo da
 * `example.com` sia per i cookie sia per gli origin. A togliere il `www.` è
 * l'HOST cercato, lato client, quando confronta (`matchSiteRecords`).
 *
 * Il modulo è PURO: prende uno stato, ritorna record o un altro stato. Il
 * contesto vivo e il file su disco li muove `browser-service`, che è l'unico a
 * sapere se un contesto è acceso.
 */
import type { BrowserStorageState } from "./browser-state-store";

/** Un silo: il nome che il dialogo mostra e i tipi di dato che contiene. La
 *  forma sta in `shared/` perché la dicono in due, e ricopiarla qui vorrebbe
 *  dire due forme che divergono in silenzio. */
export type { SiteDataRecord } from "../shared/browser-site-record";
import type { SiteDataRecord } from "../shared/browser-site-record";

/**
 * I tipi, nell'ordine in cui il client li raggruppa. La cache HTTP NON è in
 * lista e non ci sarà: nel condiviso non è per-sito (è del browser headless
 * intero), quindi prometterla nel dialogo sarebbe una bugia.
 */
const TYPE_ORDER = ["cookies", "localStorage", "indexedDB"] as const;

/** Il nome del silo di un cookie: il dominio senza il punto iniziale. */
export function cookieSilo(domain: string): string {
  return (domain || "").trim().toLowerCase().replace(/^\./, "");
}

/** Il nome del silo di un origin: il suo hostname. Vuoto se non è una URL. */
export function originSilo(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function addType(into: Map<string, Set<string>>, name: string, type: string): void {
  if (!name) return;
  const types = into.get(name);
  if (types) types.add(type);
  else into.set(name, new Set([type]));
}

/**
 * L'inventario dei silo di uno stato salvato: una riga per nome, con i tipi
 * che ci ha trovato dentro.
 *
 * Un origin senza niente dentro (nessun localStorage, nessun database) NON
 * produce una riga: Playwright lo elenca comunque quando la pagina è stata
 * visitata, ma «dimentica un sito che non ha salvato nulla» è un tasto che non
 * fa niente, e nel dialogo sarebbe rumore.
 *
 * Ritorna i nomi in ordine alfabetico, così due letture della stessa cosa
 * danno la stessa lista e il dialogo non balla fra un'apertura e l'altra.
 */
export function siteDataRecords(state: BrowserStorageState | null | undefined): SiteDataRecord[] {
  const byName = new Map<string, Set<string>>();
  for (const cookie of state?.cookies ?? []) {
    addType(byName, cookieSilo(cookie?.domain ?? ""), "cookies");
  }
  for (const origin of state?.origins ?? []) {
    const name = originSilo(origin?.origin ?? "");
    if (!name) continue;
    if ((origin.localStorage ?? []).length > 0) addType(byName, name, "localStorage");
    // `indexedDB` c'è solo quando lo stato è stato salvato con `indexedDB:true`
    // (il servizio lo fa), e su Playwright è comunque opzionale nel tipo.
    const idb = (origin as { indexedDB?: unknown[] }).indexedDB;
    if (Array.isArray(idb) && idb.length > 0) addType(byName, name, "indexedDB");
  }
  return [...byName.entries()]
    .map(([displayName, types]) => ({
      displayName,
      types: TYPE_ORDER.filter((t) => types.has(t)) as string[],
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Gli origin dello stato che appartengono ai silo nominati. Servono al
 * contesto VIVO: `Storage.clearDataForOrigin` vuole l'origin completo
 * (`https://foo.io`), non l'host, e vuole tutti gli schemi presenti.
 */
export function originsOfSilos(
  state: BrowserStorageState | null | undefined,
  displayNames: string[],
): string[] {
  const targets = new Set(displayNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const out = new Set<string>();
  for (const origin of state?.origins ?? []) {
    const raw = origin?.origin ?? "";
    if (raw && targets.has(originSilo(raw))) out.add(raw);
  }
  return [...out];
}

/**
 * Lo stato senza i silo nominati, e quanti ne ha tolti davvero.
 *
 * Il filtro è PER NOME e non per host: i nomi sono quelli che il dialogo ha
 * mostrato e che l'utente ha letto prima di premere. Rifare qui il confronto
 * fra host e silo vorrebbe dire che fra il «cosa cancello» e il «cancella»
 * può infilarsi una regola diversa, ed è esattamente il patto che questo
 * comando non deve rompere.
 *
 * `removed` conta i SILO spariti (quelli che c'erano e ora non ci sono), non i
 * cookie: è il numero che il dialogo può dire senza mentire, ed è la stessa
 * unità che ritorna il nativo.
 */
export function forgetSilosInState(
  state: BrowserStorageState,
  displayNames: string[],
): { state: BrowserStorageState; removed: number } {
  const targets = new Set(displayNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (targets.size === 0) return { state, removed: 0 };
  const before = new Set(siteDataRecords(state).map((r) => r.displayName));
  const next: BrowserStorageState = {
    ...state,
    cookies: (state.cookies ?? []).filter((c) => !targets.has(cookieSilo(c?.domain ?? ""))),
    origins: (state.origins ?? []).filter((o) => !targets.has(originSilo(o?.origin ?? ""))),
  };
  let removed = 0;
  for (const name of targets) if (before.has(name)) removed++;
  return { state: next, removed };
}
