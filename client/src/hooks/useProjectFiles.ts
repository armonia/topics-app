import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { filesApi } from '../lib/api';
import type { FileNode, WSMessage } from '../types';

/**
 * L'albero dei file di un progetto, in uno store che SOPRAVVIVE al pannello.
 *
 * ── Perché esiste ──────────────────────────────────────────────────────────
 * Aprendo e chiudendo la sezione Files si vedeva uno spinner ogni volta, come
 * se non ci fosse nessuna cache. Non c'era: `ProjectSidebar` monta il
 * FileExplorer dentro `{expandedSections.files && …}`, quindi chiudere la
 * sezione lo SMONTA — e con lui morivano l'albero, le cartelle aperte e
 * `initialLoadDone`, che era una `useRef`. Quel ref serviva a non far
 * lampeggiare l'albero sulle ricariche dal watcher, e funzionava; ma ha
 * esattamente la vita del componente, e la chiusura è ciò che quella vita la
 * termina. Stesso difetto sul secondo gesto: collassare l'intera barra la
 * riduce a una rail e smonta tutto lo stesso.
 *
 * Lo spinner era GARANTITO, non probabile: `loading` nasceva `true`, quindi il
 * primo render era già il ramo spinner — a piena altezza, al posto dell'albero
 * — prima ancora che partisse la fetch. La latenza governava solo la durata:
 * 25-30ms a riposo, ~90ms con qualche richiesta concorrente, secondi pieni con
 * l'event loop del server conteso.
 *
 * ── La riga che conta ──────────────────────────────────────────────────────
 * `loading: !cached`. In questo store `loading` significa «non ho dati», mai
 * «sto chiedendo»: con un albero in mano si revalida sotto, in silenzio. È la
 * stessa scelta di `useGitStatus`, di cui questo modulo è il gemello.
 *
 * ── E l'errore non cancella ciò che so ─────────────────────────────────────
 * `error` resta nello snapshot ma non sostituisce l'albero: chi rende decide,
 * e il cartello rosso a piena altezza vale solo quando `tree === null`. Prima
 * bastava una revalidazione caduta in una finestra di riavvio del server per
 * buttare via un albero completo e corretto. Su questa macchina quella
 * finestra è frequente — `TOPICS_SERVER_WATCH=1` fa ripartire il server a ogni
 * salvataggio sotto `server/`, misurati 33 riavvii in un'ora — e la fetch non
 * aveva nessun ritentativo. Ora il backoff riparte da 2s, così una finestra da
 * 3-5s è coperta dal secondo tentativo e non si vede niente.
 */

/** Passo di revalidazione quando il canale WS non c'è. */
const POLL_NO_WS = 30_000;
/** Col push del watcher attivo non serve chiedere: si tiene solo una rete. */
const POLL_WITH_WS = 120_000;
/** Il primo ritentativo dopo un errore: corto, perché di solito passa da solo. */
const POLL_ERROR_FIRST = 2_000;
const POLL_ERROR_MAX = 120_000;
/** Profondità della lettura iniziale: la stessa che il pannello chiedeva. */
export const ROOT_DEPTH = 3;
const CACHE_KEY = 'project-files-cache';

export interface ProjectFilesSnapshot {
  /** `null` = non ho mai avuto dati. Diverso da «albero vuoto». */
  tree: FileNode[] | null;
  /** Le cartelle aperte, che sopravvivono alla chiusura del pannello. */
  expandedDirs: string[];
  loading: boolean;
  error: string | null;
  /** Il filesystem è cambiato mentre nessuno guardava: si revalida al ritorno. */
  stale: boolean;
}

type Store = {
  snapshot: ProjectFilesSnapshot;
  listeners: Set<() => void>;
  subscribers: number;
  timer: ReturnType<typeof setInterval> | null;
  currentInterval: number;
  fetching: boolean;
  refetchQueued: boolean;
  queuedExplicit: boolean;
  wsChannels: number;
  errorStreak: number;
  /** Annulla la fetch in volo quando ne parte una esplicita. */
  abort: AbortController | null;
};

/**
 * La cache di sessione: l'albero sopravvive anche a un ⌘R.
 *
 * Si salva solo la radice e le cartelle aperte, non i sottoalberi comprati
 * pigramente: quelli possono essere molti e il quota di sessionStorage è
 * condiviso con tutto il resto. Il `try/catch` ingoia il quota-exceeded, come
 * fa `gitCache`.
 */
const filesCache = {
  get(path: string): { tree: FileNode[]; expandedDirs: string[] } | undefined {
    try {
      const raw = sessionStorage.getItem(`${CACHE_KEY}:${path}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  },
  set(path: string, entry: { tree: FileNode[]; expandedDirs: string[] }) {
    try {
      sessionStorage.setItem(`${CACHE_KEY}:${path}`, JSON.stringify(entry));
    } catch { /* quota exceeded — pazienza, si ricarica */ }
  },
};

const stores = new Map<string, Store>();

function getStore(path: string): Store {
  let s = stores.get(path);
  if (!s) {
    const cached = filesCache.get(path);
    s = {
      snapshot: {
        tree: cached?.tree ?? null,
        expandedDirs: cached?.expandedDirs ?? [],
        // La riga che toglie lo spinner: se ho dati, non sto caricando —
        // sto revalidando, che è un'altra cosa e non si mostra.
        loading: !cached,
        error: null,
        stale: false,
      },
      listeners: new Set(),
      subscribers: 0,
      timer: null,
      currentInterval: POLL_NO_WS,
      fetching: false,
      refetchQueued: false,
      queuedExplicit: false,
      wsChannels: 0,
      errorStreak: 0,
      abort: null,
    };
    stores.set(path, s);
  }
  return s;
}

function patch(store: Store, next: Partial<ProjectFilesSnapshot>) {
  const merged = { ...store.snapshot, ...next };
  if (
    merged.tree === store.snapshot.tree &&
    merged.expandedDirs === store.snapshot.expandedDirs &&
    merged.loading === store.snapshot.loading &&
    merged.error === store.snapshot.error &&
    merged.stale === store.snapshot.stale
  ) return;
  store.snapshot = merged;
  for (const l of store.listeners) l();
}

/** Il passo desiderato: rilassato col WS, corto dopo un errore. */
export function desiredInterval(store: Pick<Store, 'wsChannels' | 'errorStreak'>): number {
  const base = store.wsChannels > 0 ? POLL_WITH_WS : POLL_NO_WS;
  if (store.errorStreak === 0) return base;
  return Math.min(POLL_ERROR_MAX, POLL_ERROR_FIRST * 2 ** Math.min(store.errorStreak - 1, 6));
}

function retime(path: string, store: Store) {
  if (store.subscribers === 0) {
    if (store.timer) { clearInterval(store.timer); store.timer = null; }
    return;
  }
  const want = desiredInterval(store);
  if (store.timer && want === store.currentInterval) return;
  store.currentInterval = want;
  if (store.timer) clearInterval(store.timer);
  store.timer = setInterval(() => { void load(path); }, want);
}

/**
 * Ricarica la radice.
 *
 * @param esplicita chiesta da un'AZIONE (creare, rinominare, cancellare, il
 *                  bottone Riprova) e non dal timer: annulla la fetch in volo
 *                  invece di accodarsi, perché chi ha appena creato un file sta
 *                  chiedendo lo stato di ADESSO.
 */
async function load(path: string, esplicita = false): Promise<void> {
  const store = getStore(path);
  if (store.fetching) {
    store.refetchQueued = true;
    if (esplicita) store.queuedExplicit = true;
    return;
  }
  store.fetching = true;
  // Solo senza dati. Con un albero in mano si revalida in silenzio: è la
  // differenza fra «non ho niente da mostrarti» e «sto controllando».
  if (!store.snapshot.tree) patch(store, { loading: true });

  const controller = new AbortController();
  store.abort = controller;
  try {
    const tree = await filesApi.list(path, ROOT_DEPTH, controller.signal);
    if (controller.signal.aborted) return;
    store.errorStreak = 0;
    // Al primo albero si aprono le cartelle di primo livello, come faceva il
    // pannello. Dopo NON si tocca più: le cartelle che l'utente ha aperto sono
    // sue, e riaprire il pannello non è un motivo per richiuderle.
    const expandedDirs = store.snapshot.tree
      ? store.snapshot.expandedDirs
      : tree.filter(f => f.type === 'dir').map(f => f.path);
    patch(store, { tree, expandedDirs, loading: false, error: null, stale: false });
    filesCache.set(path, { tree, expandedDirs });
  } catch (err: unknown) {
    if (controller.signal.aborted) return;
    store.errorStreak++;
    // L'errore NON cancella l'albero: chi rende decide se mostrarlo come banda
    // sopra i dati (li ho) o come cartello (non li ho).
    patch(store, { error: (err as { message?: string })?.message || 'Impossibile leggere i file', loading: false });
  } finally {
    if (store.abort === controller) store.abort = null;
    store.fetching = false;
    retime(path, store);
    if (store.refetchQueued) {
      store.refetchQueued = false;
      const eraEsplicita = store.queuedExplicit;
      store.queuedExplicit = false;
      void load(path, eraEsplicita);
    }
  }
}

/**
 * I figli di una cartella aperta pigramente, innestati nell'albero.
 *
 * Conserva l'IDENTITÀ dei rami che non cambiano. La versione ingenua —
 * `nodes.map(n => n.children ? {...n, children: ricorsione} : n)` — ricrea ogni
 * cartella che ha figli lungo tutto l'albero, non solo quelle sul cammino:
 * innestare una cartella qualunque produceva un albero nuovo da cima a fondo,
 * e ogni `useMemo` a valle che dipende da quei nodi lo ricalcolava per niente.
 */
function graftChildren(nodes: FileNode[], target: string, children: FileNode[]): FileNode[] {
  let cambiato = false;
  const out = nodes.map(n => {
    if (n.path === target) { cambiato = true; return { ...n, children }; }
    if (!n.children) return n;
    const figli = graftChildren(n.children, target, children);
    if (figli === n.children) return n;
    cambiato = true;
    return { ...n, children: figli };
  });
  return cambiato ? out : nodes;
}

/**
 * Il push del watcher, instradato allo store del suo progetto.
 *
 * Il gate su `subscribers` non è un'ottimizzazione: `server/file-watcher.ts`
 * trasmette a OGNI modifica del filesystem, e camminare l'albero a tre livelli
 * per un pannello che nessuno sta guardando sarebbe carico puro — su questa
 * macchina, con gli agenti che scrivono di continuo, parecchio. Chiuso si segna
 * `stale` e si revalida al ritorno.
 */
function applyWSMessage(msg: WSMessage) {
  if (msg.type !== 'files:changed' || !msg.projectPath) return;
  const path = msg.projectPath as string;
  const store = stores.get(path);
  if (!store) return;
  if (store.subscribers === 0) { patch(store, { stale: true }); return; }
  void load(path);
}

interface UseProjectFilesOptions {
  projectPath: string;
  /** Fornire il canale accende il push per TUTTI i consumer di questo path. */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function useProjectFiles({ projectPath, onMessage }: UseProjectFilesOptions) {
  // `useCallback` non è cosmetico: `useSyncExternalStore` si ri-iscrive a ogni
  // cambio d'identità di `subscribe`, e il contatore sfarfallerebbe 1→0→1.
  const subscribe = useCallback((listener: () => void) => {
    const store = getStore(projectPath);
    store.listeners.add(listener);
    store.subscribers++;
    if (store.subscribers === 1) {
      // Al ritorno si revalida sempre: costa una richiesta e toglie il dubbio
      // che l'albero mostrato sia vecchio. Senza spinner, perché i dati ci sono.
      void load(projectPath);
      retime(projectPath, store);
    }
    return () => {
      store.listeners.delete(listener);
      store.subscribers--;
      if (store.subscribers === 0) retime(projectPath, store);
    };
  }, [projectPath]);

  const getSnapshot = useCallback(() => getStore(projectPath).snapshot, [projectPath]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!onMessage) return;
    const store = getStore(projectPath);
    const unsub = onMessage(applyWSMessage);
    store.wsChannels++;
    retime(projectPath, store);
    return () => {
      unsub();
      store.wsChannels = Math.max(0, store.wsChannels - 1);
      retime(projectPath, store);
    };
  }, [onMessage, projectPath]);

  const reload = useCallback(() => load(projectPath, true), [projectPath]);

  /** Segna una cartella come aperta o chiusa, e lo ricorda. */
  const setExpanded = useCallback((dir: string, aperta: boolean) => {
    const store = getStore(projectPath);
    const attuali = new Set(store.snapshot.expandedDirs);
    if (aperta) attuali.add(dir); else attuali.delete(dir);
    const expandedDirs = [...attuali];
    patch(store, { expandedDirs });
    if (store.snapshot.tree) filesCache.set(projectPath, { tree: store.snapshot.tree, expandedDirs });
  }, [projectPath]);

  /** Sostituisce in blocco l'insieme delle cartelle aperte. */
  const replaceExpanded = useCallback((dirs: string[]) => {
    const store = getStore(projectPath);
    patch(store, { expandedDirs: dirs });
    if (store.snapshot.tree) filesCache.set(projectPath, { tree: store.snapshot.tree, expandedDirs: dirs });
  }, [projectPath]);

  /**
   * Innesta i figli di una cartella caricata pigramente.
   *
   * Vivono nello store e non nel componente: erano stati pagati con una
   * richiesta per cartella, e buttarli via a ogni chiusura del pannello
   * significava ricomprarli tutti uno per uno alla riapertura.
   */
  const graft = useCallback((dir: string, children: FileNode[]) => {
    const store = getStore(projectPath);
    if (!store.snapshot.tree) return;
    patch(store, { tree: graftChildren(store.snapshot.tree, dir, children) });
  }, [projectPath]);

  return { ...snapshot, reload, setExpanded, replaceExpanded, graft };
}

/** Per i test: azzera gli store fra un caso e l'altro. */
export function __resetProjectFilesStores() {
  for (const s of stores.values()) {
    if (s.timer) clearInterval(s.timer);
    s.abort?.abort();
  }
  stores.clear();
}

export { filesCache, graftChildren };
