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
import { boardRowsCacheKey, readBoardRowsCache, serializeBoardRowsCache } from './boardRowsCache';
import { createThrottledLocalWriter } from './throttledLocalWrite';

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
// The cache paints the next boot; current readers observe the store immediately.
// Defer both serialization and storage through the existing fixed-window writer,
// which also flushes the latest snapshot on pagehide / document-hidden.
const cacheWriter = createThrottledLocalWriter({ key: boardRowsCacheKey(ALL_BOARDS_SCOPE) });

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

/** Values of a task are JSON data. Compare without allocating serialized
 * copies: repeated frames often have fresh arrays/objects but unchanged fields.
 * Object key order is immaterial; array order and missing fields are not. */
function sameTaskValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return aKeys.every((key) => Object.hasOwn(right, key) && sameTaskValue(left[key], right[key]));
}

/** Publish changed rows immediately. A repeated feed keeps its identities, so
 * subscribers and the first-frame cache pay only for real changes. */
export function setBoardTasks(next: readonly BoardTask[]): void {
  const reconciled = next.map((row, i) => sameTaskValue(tasks[i], row) ? tasks[i] : row);
  const unchanged = reconciled.length === tasks.length && reconciled.every((row, i) => row === tasks[i]);
  if (unchanged && loaded) return;
  if (!unchanged) tasks = reconciled;
  loaded = true;
  // The read answered: whatever the board was saying about the previous
  // failure stops being true here. An EMPTY `next` included - that is the
  // legitimate "read it, there is nothing" case, which has nothing to report.
  error = null;
  // The write stays THROTTLED (main's writer, kept over the direct call this
  // branch was written against): the rows change on every streamed frame, and
  // WebKit's journal grows with the number of rewrites, not with the bytes.
  const snapshot = tasks;
  cacheWriter.write(() => serializeBoardRowsCache(snapshot));
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
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return;
  const row = tasks[i];
  const keys = Object.keys(patch) as (keyof BoardTask)[];
  if (keys.every((key) => Object.hasOwn(row, key) && sameTaskValue(row[key], patch[key]))) return;
  const next = tasks.slice();
  next[i] = { ...row, ...patch };
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
const EMPTY_TASKS: readonly BoardTask[] = [];
const noSubscription = () => () => {};
const noTasks = () => EMPTY_TASKS;
const notLoaded = () => false;

export function useBoardTasks(enabled = true): readonly BoardTask[] {
  return useSyncExternalStore(
    enabled ? subscribeBoardTasks : noSubscription,
    enabled ? getBoardTasks : noTasks,
    enabled ? getBoardTasks : noTasks,
  );
}

/** «La prima lettura è tornata?», reattivo (vedi `hasLoadedBoardTasks`). */
export function useBoardTasksLoaded(enabled = true): boolean {
  return useSyncExternalStore(
    enabled ? subscribeBoardTasks : noSubscription,
    enabled ? hasLoadedBoardTasks : notLoaded,
    enabled ? hasLoadedBoardTasks : notLoaded,
  );
}

/** "Did the last read fail?", reactive (see `getBoardTasksError`). */
export function useBoardTasksError(): string | null {
  return useSyncExternalStore(subscribeBoardTasks, getBoardTasksError, getBoardTasksError);
}
