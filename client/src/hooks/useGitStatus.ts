import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { gitApi } from '../lib/api';
import type { GitStatus, WSMessage } from '../types';

const POLL_VISIBLE = 15000;
const POLL_BACKGROUND = 60000;
/** Backoff massimo dopo errori consecutivi (vedi `desiredInterval`). */
const POLL_ERROR_MAX = 120000;
/** Il primo ritentativo dopo un errore: corto, perché il primo errore di solito passa da solo. */
const POLL_ERROR_FIRST = 2000;
/**
 * Ogni quanto si aggiornano le ref remote-tracking.
 *
 * `ahead`/`behind` escono da `rev-list …@{upstream}`, che legge una ref LOCALE:
 * senza un fetch quella ref non si muove, `behind` resta 0 per sempre e il
 * bottone Pull — gatato su `behind > 0` — non compare mai. Un collega pusha su
 * main e qui non se ne accorge nessuno. Tre minuti è l'ordine di grandezza di
 * VS Code (180s) e costa una connessione ogni tre minuti per progetto APERTO,
 * non per progetto conosciuto: il fetch parte solo se qualcuno è iscritto.
 */
const AUTOFETCH_MS = 180000;
const CACHE_KEY = 'git-status-cache';

type GitCacheEntry = { status: GitStatus; remotes: { name: string; fetchUrl: string; pushUrl: string }[] };

// ── Session cache (shared with other consumers via sessionStorage) ──────────

const gitCache = {
  get(path: string): GitCacheEntry | undefined {
    try {
      const raw = sessionStorage.getItem(`${CACHE_KEY}:${path}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  },
  set(path: string, entry: GitCacheEntry) {
    try {
      sessionStorage.setItem(`${CACHE_KEY}:${path}`, JSON.stringify(entry));
    } catch { /* quota exceeded — ignore */ }
  },
};

export { gitCache };

// ── Store condiviso per projectPath ─────────────────────────────────────────
//
// Perché un singleton e non un hook con il suo timer, com'era prima: i consumer
// dello STESSO progetto sono già almeno due (FileExplorer per le decorazioni,
// GitChanges per il pannello) e ognuno faceva partire il proprio `setInterval`.
// Due `git status --porcelain` ogni 15s per lo stesso repo, che diventano tre
// appena una terza superficie vuole il numero delle modifiche — ed è esattamente
// quello che serve alla rail collassata. Qui il timer è UNO per path, come in
// `useScripts`, e chi si aggancia dopo trova i dati già pronti.
//
// L'altra metà del problema era il canale WS. Il server ha un watcher su
// `.git` (`server/git-watcher.ts`) che ricalcola lo stato e lo trasmette come
// `git:status` entro 500ms da un commit; ma nessuno dei due consumer passava
// `onMessage`, quindi quel push non arrivava a nessuno e l'interfaccia restava
// ferma sul poll da 15s. Basta che UNA superficie fornisca il canale (la
// sidebar progetto, che l'ha già come prop) perché tutte le altre ne godano.

type Snapshot = {
  gitStatus: GitStatus | null;
  loading: boolean;
  error: string | null;
  notGit: boolean;
};

type Store = {
  snapshot: Snapshot;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribers: number;
  fetching: boolean;
  /** Una richiesta arrivata mentre un'altra era in volo, da rieseguire dopo. */
  refetchQueued: boolean;
  /** Quella in coda veniva da un'azione, non dal timer: non va declassata. */
  queuedExplicit: boolean;
  /** Quanti consumer hanno fornito un canale WS: >0 ⇒ poll rilassato. */
  wsChannels: number;
  /** Errori consecutivi, per il backoff. Azzerato al primo successo. */
  errorStreak: number;
  /**
   * Quanti push WS sono arrivati. Serve a NON far vincere una risposta di poll
   * partita PRIMA di un push: vedi `load`.
   */
  pushSeq: number;
  currentInterval: number;
  /** Timer dell'autofetch, separato dal poll: passi diversi. */
  fetchTimer: ReturnType<typeof setInterval> | null;
  fetchingRemote: boolean;
  /** Il fetch fallisce di continuo (nessun remote, niente rete): si smette. */
  fetchDisabled: boolean;
};

const stores = new Map<string, Store>();

function getStore(path: string): Store {
  let s = stores.get(path);
  if (!s) {
    const cached = gitCache.get(path);
    s = {
      snapshot: {
        gitStatus: cached?.status ?? null,
        loading: !cached,
        error: null,
        notGit: false,
      },
      listeners: new Set(),
      timer: null,
      subscribers: 0,
      fetching: false,
      refetchQueued: false,
      queuedExplicit: false,
      wsChannels: 0,
      errorStreak: 0,
      pushSeq: 0,
      currentInterval: POLL_VISIBLE,
      fetchTimer: null,
      fetchingRemote: false,
      fetchDisabled: false,
    };
    stores.set(path, s);
  }
  return s;
}

function patch(store: Store, next: Partial<Snapshot>) {
  const merged = { ...store.snapshot, ...next };
  if (
    merged.gitStatus === store.snapshot.gitStatus &&
    merged.loading === store.snapshot.loading &&
    merged.error === store.snapshot.error &&
    merged.notGit === store.snapshot.notGit
  ) return;
  store.snapshot = merged;
  for (const l of store.listeners) l();
}

function publish(path: string, store: Store, status: GitStatus) {
  patch(store, { gitStatus: status, notGit: false, error: null, loading: false });
  const prev = gitCache.get(path);
  gitCache.set(path, { status, remotes: prev?.remotes ?? [] });
  window.dispatchEvent(new CustomEvent('git-cache-updated'));
}

/**
 * Intervallo desiderato: rilassato con il WS attivo, allungato dopo errori.
 *
 * Il backoff parte CORTO, non dal passo normale moltiplicato. Prima il primo
 * errore portava l'intervallo a 30 secondi, e il caso piu comune di errore e
 * anche il piu effimero: il server tiene l'allowlist dei progetti in una cache
 * da 5 secondi, quindi una cartella appena aperta puo prendersi un 400 e basta
 * aspettare un battito. Con il vecchio passo si guardava un pannello in errore
 * per mezzo minuto quando la risposta giusta era li dopo due secondi.
 *
 * 2s, 4s, 8s… fino al tetto: un blip si ripiglia subito, un guasto vero
 * si dirada lo stesso.
 */
export function desiredInterval(store: Pick<Store, 'wsChannels' | 'errorStreak'>): number {
  const base = store.wsChannels > 0 ? POLL_BACKGROUND : POLL_VISIBLE;
  if (store.errorStreak === 0) return base;
  return Math.min(POLL_ERROR_MAX, POLL_ERROR_FIRST * 2 ** Math.min(store.errorStreak - 1, 6));
}

function retime(path: string, store: Store) {
  // `notGit` è definitivo: la cartella non è un repo, non lo diventerà da sola.
  if (store.subscribers === 0 || store.snapshot.notGit) {
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
 * @param esplicita  chiesta da un'AZIONE (commit, stage, il bottone Aggiorna) e
 *                   non dal timer. Una richiesta esplicita vince sempre: vedi
 *                   la guardia sul push piu sotto.
 */
async function load(path: string, esplicita = false) {
  const store = getStore(path);
  if (store.snapshot.notGit) return;
  // Una fetch già in volo non fa perdere la richiesta: la accoda. Scartarla
  // sarebbe una regressione silenziosa per chi chiama `reload()` subito dopo
  // uno stage o un commit — il pannello resterebbe sul vecchio stato.
  if (store.fetching) {
    store.refetchQueued = true;
    if (esplicita) store.queuedExplicit = true;
    return;
  }
  store.fetching = true;
  if (!store.snapshot.gitStatus) patch(store, { loading: true });
  // Da quale stato partiamo. Se nel frattempo arriva un push, questa risposta
  // descrive un momento PRECEDENTE e non deve vincere.
  const pushAtStart = store.pushSeq;
  try {
    const status = await gitApi.status(path);
    // Il server risponde 200 con `{ notGit: true }` per una cartella non-repo.
    if ((status as { notGit?: boolean }).notGit) {
      patch(store, { notGit: true, loading: false, error: null });
      retime(path, store);
      return;
    }
    store.errorStreak = 0;
    // Il push ha gia detto una cosa piu recente: questa risposta e vecchia.
    //
    // Succedeva dopo un commit: il client committa, chiede subito lo stato, e
    // quella richiesta parte quando il server ha ancora in cache la lista di
    // PRIMA (la cache dello stato dura 5s e la invalida il watcher, che sente
    // il filesystem con un suo ritardo). Nel frattempo il push del watcher
    // arriva con l'albero pulito, il pannello si aggiorna, e un istante dopo la
    // risposta stantia lo riportava indietro. Da li restava sbagliato fino al
    // poll successivo: quindici secondi in cui «ho committato e vedo ancora le
    // modifiche».
    // …ma una richiesta ESPLICITA vince comunque. Chi committa e poi ricarica
    // sta chiedendo lo stato di ADESSO, e la sua risposta e' piu recente di
    // qualunque push partito prima: scartarla lascerebbe il pannello indietro
    // proprio nel momento in cui l'utente guarda per vedere l'effetto.
    if (!esplicita && store.pushSeq !== pushAtStart) { retime(path, store); return; }
    publish(path, store, status);
    retime(path, store);
  } catch (err: unknown) {
    const e = err as { notGit?: boolean; message?: string } | null | undefined;
    if (e?.notGit) {
      patch(store, { notGit: true, loading: false, error: null });
    } else {
      // Un errore NON spegne il poll — lo dirada. Prima si azzerava il timer, e
      // un singolo blip (server che ricarica, rete che sfarfalla) congelava lo
      // stato git di quel progetto fino al successivo rimontaggio del pannello:
      // i numeri restavano quelli di prima, senza dire che erano vecchi.
      store.errorStreak++;
      patch(store, { error: e?.message || 'Git error', loading: false });
    }
    retime(path, store);
  } finally {
    store.fetching = false;
    if (store.refetchQueued) {
      store.refetchQueued = false;
      const eraEsplicita = store.queuedExplicit;
      store.queuedExplicit = false;
      void load(path, eraEsplicita);
    }
  }
}

/**
 * Aggiorna le ref remote-tracking e ricarica lo stato.
 *
 * Fallisce in silenzio ed è giusto così: una cartella senza remote, o senza
 * rete, non è un errore da mostrare — nessuno l'ha chiesto, è un giro di
 * manutenzione. Ma dopo il secondo fallimento si smette del tutto, per non
 * spendere una connessione ogni tre minuti su un repo che non ne ha uno.
 */
async function autofetch(path: string) {
  const store = getStore(path);
  if (store.snapshot.notGit || store.fetchDisabled || store.fetchingRemote) return;
  if (store.subscribers === 0) return;
  store.fetchingRemote = true;
  try {
    await gitApi.fetch(path);
    store.fetchDisabled = false;
    await load(path);
  } catch {
    store.errorStreak++;
    if (store.errorStreak >= 2) store.fetchDisabled = true;
  } finally {
    store.fetchingRemote = false;
  }
}

function retimeFetch(path: string, store: Store) {
  if (store.subscribers === 0 || store.snapshot.notGit || store.fetchDisabled) {
    if (store.fetchTimer) { clearInterval(store.fetchTimer); store.fetchTimer = null; }
    return;
  }
  if (store.fetchTimer) return;
  store.fetchTimer = setInterval(() => { void autofetch(path); }, AUTOFETCH_MS);
}

/** Il push del watcher server-side, instradato allo store del suo progetto. */
function applyWSMessage(msg: WSMessage) {
  if (msg.type !== 'git:status' || !msg.projectPath || !msg.status) return;
  const path = msg.projectPath as string;
  const store = stores.get(path);
  if (!store) return;
  store.errorStreak = 0;
  store.pushSeq++;
  publish(path, store, msg.status as GitStatus);
  retime(path, store);
}

interface UseGitStatusOptions {
  projectPath: string;
  /** Fornire il canale WS accende il push realtime per TUTTI i consumer di
   *  questo progetto, non solo per chi lo passa. */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function useGitStatus({ projectPath, onMessage }: UseGitStatusOptions) {
  // `useCallback` non è cosmetico: `useSyncExternalStore` si ri-iscrive ogni
  // volta che l'identità di `subscribe` cambia. Con una funzione nuova a ogni
  // render il contatore degli iscritti sfarfallerebbe 1→0→1 e il timer
  // ripartirebbe da capo a ogni render.
  const subscribe = useCallback((listener: () => void) => {
    const store = getStore(projectPath);
    store.listeners.add(listener);
    store.subscribers++;
    if (store.subscribers === 1) {
      void load(projectPath);
      retime(projectPath, store);
      retimeFetch(projectPath, store);
    }
    return () => {
      store.listeners.delete(listener);
      store.subscribers--;
      if (store.subscribers === 0) { retime(projectPath, store); retimeFetch(projectPath, store); }
    };
  }, [projectPath]);
  const getSnapshot = useCallback(() => getStore(projectPath).snapshot, [projectPath]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Canale WS: si conta quanti lo forniscono, così l'ultimo che se ne va
  // riporta il poll al passo stretto invece di lasciare tutti a 60s al buio.
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
  /** Fetch su richiesta (bottone), che riabilita anche l'autofetch spento. */
  const fetchRemote = useCallback(async () => {
    const store = getStore(projectPath);
    store.fetchDisabled = false;
    await gitApi.fetch(projectPath);
    await load(projectPath);
    retimeFetch(projectPath, store);
  }, [projectPath]);

  return {
    gitStatus: snapshot.gitStatus,
    loading: snapshot.loading,
    error: snapshot.error,
    notGit: snapshot.notGit,
    reload,
    fetchRemote,
    gitCache,
  };
}
