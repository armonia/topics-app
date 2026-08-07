import { useCallback, useSyncExternalStore } from 'react';
import { filesApi } from '../lib/api';
import type { DetectedScript } from '../types';

/**
 * Gli script rilevati di un progetto, in uno store che sopravvive al pannello.
 *
 * Stesso difetto del FileExplorer e sotto lo stesso gesto: `ProjectSidebar`
 * monta `ScriptRunner` dentro `{expandedSections.processes && …}`, quindi
 * chiudere la sezione lo smonta e `ready` riparte da `false` — cioè il pannello
 * riapre sullo spinner, che è un early return a piena altezza.
 *
 * Qui il costo del server è trascurabile (`detectScripts` misurato 0,105 ms),
 * quindi il sintomo è un lampo e non un'attesa. Ma è lo stesso difetto, e
 * lasciarlo significa che il prossimo che guarda questo file trova due pannelli
 * gemelli con due comportamenti diversi senza un motivo. Lo schema è quello di
 * `useProjectFiles` e `useGitStatus`, ridotto all'essenziale: niente poll —
 * i manifest cambiano quando li cambi tu, e chi riapre la sezione revalida.
 */

const CACHE_KEY = 'project-scripts-cache';

export interface DetectedScriptsSnapshot {
  scripts: DetectedScript[];
  /** I manifest trovati nel progetto. */
  found: string[];
  /** Quelli che il server guarda: rende leggibile l'assenza. */
  looked: string[];
  /** `false` finché non si è mai avuta una risposta. */
  ready: boolean;
}

type Store = {
  snapshot: DetectedScriptsSnapshot;
  listeners: Set<() => void>;
  subscribers: number;
  fetching: boolean;
};

const VUOTO: DetectedScriptsSnapshot = { scripts: [], found: [], looked: [], ready: false };

const cache = {
  get(path: string): DetectedScriptsSnapshot | undefined {
    try {
      const raw = sessionStorage.getItem(`${CACHE_KEY}:${path}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  },
  set(path: string, snap: DetectedScriptsSnapshot) {
    try { sessionStorage.setItem(`${CACHE_KEY}:${path}`, JSON.stringify(snap)); } catch { /* quota */ }
  },
};

const stores = new Map<string, Store>();

function getStore(path: string): Store {
  let s = stores.get(path);
  if (!s) {
    const cached = cache.get(path);
    s = {
      snapshot: cached ?? VUOTO,
      listeners: new Set(),
      subscribers: 0,
      fetching: false,
    };
    stores.set(path, s);
  }
  return s;
}

function patch(store: Store, next: DetectedScriptsSnapshot) {
  const p = store.snapshot;
  if (
    p.ready === next.ready &&
    p.scripts.length === next.scripts.length &&
    p.found.join() === next.found.join() &&
    p.looked.join() === next.looked.join() &&
    p.scripts.every((s, i) => s.id === next.scripts[i]?.id && s.detail === next.scripts[i]?.detail)
  ) return;
  store.snapshot = next;
  for (const l of store.listeners) l();
}

async function load(path: string): Promise<void> {
  const store = getStore(path);
  if (store.fetching) return;
  store.fetching = true;
  try {
    const dati = await filesApi.packageScripts(path);
    const snap: DetectedScriptsSnapshot = {
      scripts: dati.scripts ?? [],
      found: dati.found ?? [],
      looked: dati.looked ?? [],
      ready: true,
    };
    patch(store, snap);
    cache.set(path, snap);
  } catch {
    // Un errore qui non ha niente da dire all'utente: la sezione mostra già
    // «nessun manifest» con l'elenco di cosa cerca, e insistere con un rosso su
    // una lettura di sfondo sarebbe rumore. Ma `ready` va alzato lo stesso,
    // altrimenti il pannello resta sullo spinner per sempre.
    patch(store, { ...store.snapshot, ready: true });
  } finally {
    store.fetching = false;
  }
}

export function useDetectedScripts(projectPath: string) {
  const subscribe = useCallback((listener: () => void) => {
    const store = getStore(projectPath);
    store.listeners.add(listener);
    store.subscribers++;
    // Si revalida a ogni ritorno: costa niente e i manifest possono essere
    // cambiati mentre il pannello era chiuso. Senza spinner, perché i dati ci
    // sono già.
    void load(projectPath);
    return () => {
      store.listeners.delete(listener);
      store.subscribers--;
    };
  }, [projectPath]);

  const getSnapshot = useCallback(() => getStore(projectPath).snapshot, [projectPath]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const reload = useCallback(() => load(projectPath), [projectPath]);

  return { ...snapshot, reload };
}

/** Per i test: azzera gli store fra un caso e l'altro. */
export function __resetDetectedScriptsStores() {
  stores.clear();
}
