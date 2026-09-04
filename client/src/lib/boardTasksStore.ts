/**
 * boardTasksStore — le righe della board di TUTTI i progetti, tenute UNA volta
 * per documento e lette da chiunque le mostri.
 *
 * Perché uno store e non un hook con lo stato dentro. Il feed globale
 * (`GET /api/all-boards/tasks`) lo carica `useGlobalBoard`, montato in App, e
 * lo riaggiorna a ogni evento `task:*` del WebSocket. Finché quello stato
 * viveva dentro l'hook, ogni superficie che volesse gli stessi numeri doveva
 * montare l'hook — cioè una SECONDA fetch e una seconda sottoscrizione, con la
 * possibilità concreta di due risposte diverse nello stesso istante. Le tab
 * della board sono N (una per barra, e le barre sono una per gruppo di split),
 * quindi il conto non è due: è N.
 *
 * Qui la fetch resta una sola, dov'era — `useGlobalBoard` SCRIVE — e chi legge
 * si limita a sottoscrivere. Nessun lettore fa partire richieste: se il
 * proprietario non è montato, i lettori vedono la lista vuota, che è anche la
 * verità («non lo so ancora») per una superficie che al massimo non disegna un
 * numero.
 */
import { useSyncExternalStore } from 'react';
import type { BoardTask } from './board';
import { readBoardRowsCache, writeBoardRowsCache } from './boardRowsCache';

/** The scope of the cross-project feed inside the rows cache. */
export const ALL_BOARDS_SCOPE = 'all';

// THE SEED. Read at module load, so the first render of a board already has
// rows in its hands instead of empty columns waiting for a fetch. `loaded` goes
// with them: a seeded list is a list, and the waiting state is for a board that
// has never seen anything. The fetch leaves anyway and overwrites this.
const seeded = typeof localStorage === 'undefined' ? null : readBoardRowsCache(ALL_BOARDS_SCOPE);
let tasks: readonly BoardTask[] = seeded ?? [];
let loaded = seeded !== null;
const listeners = new Set<() => void>();

/** La lista, o quella vuota finché la prima lettura non è tornata. */
export function getBoardTasks(): readonly BoardTask[] {
  return tasks;
}

/**
 * `false` = nessuna lettura è ancora tornata, quindi la lista vuota qui sopra
 * significa «non lo so», non «non ci sono task». Chi disegna un numero può
 * ignorare la differenza; chi disegna una BOARD no: senza questo, aprirla
 * mostrava le colonne vuote per il tempo della prima fetch invece del giro
 * d'attesa.
 */
export function hasLoadedBoardTasks(): boolean {
  return loaded;
}

/**
 * Il proprietario del feed pubblica qui. Identità nuova a ogni scrittura (la
 * lista arriva già nuova dalla fetch), quindi `useSyncExternalStore` non ha
 * bisogno di nessun confronto profondo: chi legge deriva i suoi numeri con un
 * `useMemo` sulla stessa referenza.
 */
export function setBoardTasks(next: readonly BoardTask[]): void {
  tasks = next;
  loaded = true;
  writeBoardRowsCache(ALL_BOARDS_SCOPE, next);
  listeners.forEach((cb) => cb());
}

/**
 * Una lettura è TORNATA, ma a mani vuote (rete giù, server che riparte).
 *
 * Serve perché «non ho ancora letto» e «ho letto e non c'è niente» disegnano
 * due cose diverse: senza questo, una board che aspetta la prima lettura
 * filerebbe per sempre sul giro d'attesa invece di mostrare le colonne. Il
 * prossimo evento (o la riconnessione) la riempie.
 */
export function markBoardTasksSettled(): void {
  if (loaded) return;
  loaded = true;
  listeners.forEach((cb) => cb());
}

/**
 * La patch OTTIMISTA di una riga sola, da chi l'ha appena scritta al server.
 *
 * Passa da qui e non da una copia locale della superficie: da quando la board
 * generale legge queste righe, una copia locale verrebbe sovrascritta dalla
 * prima rilettura del feed — e nel frattempo le due superfici mostrerebbero la
 * stessa card in due colonne diverse. Un id che non c'è non sveglia nessuno.
 */
export function patchBoardTask(id: string, patch: Partial<BoardTask>): void {
  let hit = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    hit = true;
    return { ...t, ...patch };
  });
  if (!hit) return;
  setBoardTasks(next);
}

export function subscribeBoardTasks(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Il proprietario del feed registra qui la sua rilettura, così un LETTORE può
 * chiederne una senza aprire una seconda fetch (che è esattamente ciò che
 * questo store esiste per impedire): la richiesta finisce nel coalescer del
 * proprietario, quindi una raffica di richiedenti costa comunque una lettura.
 *
 * Senza proprietario montato non succede niente, ed è la risposta giusta: chi
 * chiede è una superficie che al massimo resta ferma un momento in più.
 */
let refresher: (() => void) | null = null;

/** Ritorna la disiscrizione: sgancia SOLO se il proprietario è ancora questo. */
export function setBoardTasksRefresher(fn: () => void): () => void {
  refresher = fn;
  return () => { if (refresher === fn) refresher = null; };
}

export function requestBoardTasksRefresh(): void {
  refresher?.();
}

/** Solo per i test: riporta lo store allo stato di boot. */
export function __resetBoardTasks(): void {
  tasks = [];
  loaded = false;
  refresher = null;
  listeners.clear();
}

/** Le righe della board, reattive. */
export function useBoardTasks(): readonly BoardTask[] {
  return useSyncExternalStore(subscribeBoardTasks, getBoardTasks, getBoardTasks);
}

/** «La prima lettura è tornata?», reattivo (vedi `hasLoadedBoardTasks`). */
export function useBoardTasksLoaded(): boolean {
  return useSyncExternalStore(subscribeBoardTasks, hasLoadedBoardTasks, hasLoadedBoardTasks);
}
