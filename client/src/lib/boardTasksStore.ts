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
/**
 * The last read of the feed did NOT arrive, and the rows above are the ones
 * from before it.
 *
 * It sits next to `loaded` because they answer two different questions and a
 * board asks both: `loaded` says whether the waiting ring can stop, this one
 * says whether what is on screen is the answer of NOW. Confusing them is the
 * defect this line closes: the seed read from the local copy is born
 * `loaded = true`, so on a failed read the cross-project board drew yesterday's
 * columns exactly the way it draws the ones from a second ago. The project
 * twin (`useBoardFeed`) already did the right thing - it keeps the rows AND
 * raises the message - and this is the half that was missing here.
 */
let error: string | null = null;
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
  // The read answered: whatever the board was saying about the previous
  // failure stops being true here. An EMPTY `next` included - that is the
  // legitimate "read it, there is nothing" case, which has nothing to report.
  error = null;
  writeBoardRowsCache(ALL_BOARDS_SCOPE, next);
  listeners.forEach((cb) => cb());
}

/**
 * A read did NOT come back (network down, a server restarting): the rows stay
 * the ones from before, and the board says so.
 *
 * TWO THINGS, AND THEY MUST STAY APART. The first is that the waiting can
 * stop: without it, a board waiting for its first read would spin on the
 * waiting ring forever instead of showing its columns, which is the one state
 * that says nothing at all. The second is the message, and that is the half
 * that was missing: stopping the ring without saying why turns a failure into
 * a board that merely looks quiet.
 *
 * This is NOT the "read it, there is nothing" case: that one goes through
 * `setBoardTasks([])`, which settles the same way but clears the error,
 * because a genuinely empty board has nothing to report. This function
 * replaced `markBoardTasksSettled`, which did only the first half and was
 * called from exactly one place - the failure - so its name promised
 * "settled" to whoever read `useGlobalBoard` while hiding that what it was
 * settling on was a failure.
 */
export function markBoardTasksFailed(message: string): void {
  if (loaded && error === message) return;
  loaded = true;
  error = message;
  listeners.forEach((cb) => cb());
}

/** Did the last read of the cross-project feed fail? Then this is why. */
export function getBoardTasksError(): string | null {
  return error;
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

/**
 * THE FRAME ALREADY CARRIES THE ROW: can the store absorb it instead of
 * re-reading the whole feed?
 *
 * The server builds the task of `task:updated` with the same `rowsToTasks` +
 * `withSubtaskCounts` as the feed, so the row that arrives IS the row a re-read
 * would bring back. But the feed is a CUT (root rows, not archived, `done`
 * column capped) and a row can enter or leave it: this only says whether the
 * frame stays INSIDE the cut, which is the id being there already, the column
 * unchanged and the parent unchanged. Everything else (creations, deletions,
 * unknown ids, a status that moved) stays a full re-read, the only thing that
 * knows which OTHER rows moved with it.
 */
export function canAbsorbBoardTaskFrame(task: BoardTask | null | undefined): boolean {
  if (!task || typeof task.id !== 'string') return false;
  const row = tasks.find((t) => t.id === task.id);
  if (!row) return false;
  if (row.status !== task.status) return false;
  return (row.parentTaskId ?? null) === (task.parentTaskId ?? null);
}

/**
 * Writes the frame's row over the one in the store, when it is absorbable.
 * `false` = it is not, and the caller owes the feed a read.
 *
 * A merge and not a replacement: a field this server does not send (a client
 * newer than its server) keeps the value it had instead of vanishing.
 */
export function applyBoardTaskFrame(task: BoardTask | null | undefined): boolean {
  if (!canAbsorbBoardTaskFrame(task)) return false;
  patchBoardTask(task!.id, task!);
  return true;
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
  error = null;
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

/** "Did the last read fail?", reactive (see `getBoardTasksError`). */
export function useBoardTasksError(): string | null {
  return useSyncExternalStore(subscribeBoardTasks, getBoardTasksError, getBoardTasksError);
}
