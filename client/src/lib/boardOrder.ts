/**
 * boardOrder.ts — l'ordine delle colonne della kanban e cosa fa un drop.
 *
 * Stava dentro `KanbanBoardPane` (1164 righe): la logica più delicata del lato
 * client — inserimento frazionario, correzione dell'indice per lo spostamento
 * verso il basso, scelta della colonna di destinazione — viveva dentro un
 * `useCallback` e l'unica spec che la sfiorava era BOARD-17, che trascina una
 * card fra due colonne: nessun caso limite, nessuno scope. Qui è pura: entra lo
 * stato, esce la patch.
 *
 * Due cose che non erano vere prima e ora lo sono:
 *
 *  1. **L'ordine è TOTALE.** Si ordinava per `kanbanOrder` e basta. A parità di
 *     numero l'ordine dipendeva da come SQLite aveva restituito le righe — che
 *     non è garantito — quindi due card pari-merito potevano scambiarsi di
 *     posto da un refetch all'altro. I pari-merito non sono ipotetici: nella
 *     board generale sono la norma (vedi sotto), e `between` dimezza l'ampiezza
 *     a ogni inserimento nello stesso interstizio, quindi anche su una board
 *     sola bastano ~50 drop per esaurire la mantissa e produrne.
 *
 *  2. **`kanbanOrder` non si confronta fra board diverse.** È assegnato per
 *     progetto (`MAX(kanban_order) + 1 WHERE project_id = ?`), quindi nella
 *     board generale un task di un progetto giovane sta sempre in cima e uno di
 *     un progetto anziano sempre in fondo — non perché qualcuno l'abbia deciso,
 *     ma perché quel progetto ha più task. Peggio: riordinare lì scriveva un
 *     `kanbanOrder` calcolato sui VICINI DI ALTRI PROGETTI, e quel numero poi
 *     spostava la card in un punto a caso della sua board vera. La board
 *     generale ordina quindi per data di creazione (chiave che esiste allo
 *     stesso modo su ogni progetto) e non riordina: trascinare fra colonne
 *     cambia lo stato — che è per-task e ha senso ovunque — ma non la posizione.
 */

import type { BoardTask, TaskStatus } from './board';
import { isAgentWorking, TASK_STATUSES } from './board';

/**
 * Come si legge l'ordine di una colonna.
 *
 * `board` = una board sola: comanda l'ordine che l'umano ha dato trascinando.
 * `cross-project` = la board generale e la fascia in sidebar: `kanbanOrder` non
 * è comparabile, si va per data di creazione.
 */
export type OrderScope = 'board' | 'cross-project';

/** Il minimo che serve per ordinare: così i test non costruiscono un BoardTask intero. */
export type OrderableTask = Pick<BoardTask, 'id' | 'kanbanOrder' | 'createdAt' | 'updatedAt' | 'completedAt'>;

/**
 * Comparatore TOTALE: due task distinti non sono mai pari-merito, quindi
 * l'ordine non dipende da come sono arrivati. `id` è l'ancora finale — arbitrario
 * ma stabile, che è tutto quel che serve per non far ballare le card.
 */
export function compareTasks(scope: OrderScope) {
  return (a: OrderableTask, b: OrderableTask): number => {
    if (scope === 'board' && a.kanbanOrder !== b.kanbanOrder) return a.kanbanOrder - b.kanbanOrder;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * Review è una casella di posta, non una corsia ordinata a mano: comanda
 * l'ultimo aggiornamento (più recente in cima), così una consegna fresca o un
 * «serve te» appena risposto sale da solo — ed è la stessa data che la card
 * mostra. Stessa coda di spareggi del comparatore normale: l'ordine è totale.
 */
const compareReview = (a: OrderableTask, b: OrderableTask): number => {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Done è una cronologia, non una corsia: comanda la data di CHIUSURA, l'ultimo
 * chiuso in cima. Prima si andava per `kanbanOrder`, che a un task chiuso non
 * dice niente: approvare dalla review non ne scrive nessuno, quindi la card
 * conservava la posizione che aveva nella colonna da cui veniva e atterrava in
 * un punto qualsiasi di Done — chiudere un task non si vedeva.
 *
 * `completedAt` è scritto dal server su ENTRAMBE le vie (approvazione e
 * trascinamento), ma può mancare sulle righe chiuse prima che esistesse: lì si
 * ripiega su `updatedAt`, che per un task fermo in Done è l'ultima cosa che gli
 * è successa. Coda di spareggi identica alle altre colonne: l'ordine è totale.
 */
const compareDone = (a: OrderableTask, b: OrderableTask): number => {
  const ka = a.completedAt ?? a.updatedAt;
  const kb = b.completedAt ?? b.updatedAt;
  if (ka !== kb) return ka < kb ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Quante card di una colonna si DISEGNANO, e quante restano dietro un «mostra
 * altri».
 *
 * Misurato sulla macchina viva il 15/08/2026: 449 dei 467 task radice sono
 * `done`. Ogni card è un sottoalbero React vivo — memo, chip, anteprima, il
 * nodo sortable che dnd-kit registra — quindi la colonna che nessuno guarda
 * costava quanto tutte le altre messe insieme, a ogni render della board.
 *
 * Il tetto vale SOLO su Review e Done, e la ragione è la stessa che le fa
 * ordinare per data (`compareReview` / `compareDone`): lì non si riordina a
 * mano, si entra e basta. Nelle tre colonne di lavoro il tetto toglierebbe una
 * card dal registro di dnd-kit — cioè un bersaglio di drop — e quello è un
 * gesto che si rompe in silenzio: backlog, todo e in_progress si disegnano
 * INTERE, sempre.
 */
export const COLUMN_PAGE = 25;

/** Le colonne a data, che si sfogliano. Le altre si disegnano intere (vedi `COLUMN_PAGE`). */
export function isPagedColumn(status: TaskStatus): boolean {
  return status === 'review' || status === 'done';
}

/** La fetta disegnata di una colonna e quante card restano fuori (0 = tutte dentro). */
export function columnSlice<T>(
  status: TaskStatus,
  tasks: readonly T[],
  shown: number,
): { rows: readonly T[]; hidden: number } {
  if (!isPagedColumn(status) || tasks.length <= shown) return { rows: tasks, hidden: 0 };
  return { rows: tasks.slice(0, shown), hidden: tasks.length - shown };
}

/**
 * Le scritture ottimistiche ANCORA IN VOLO, riappoggiate sopra le righe appena
 * atterrate.
 *
 * Una lettura partita PRIMA che la PATCH del drop finisse risponde con lo stato
 * vecchio: è una risposta giusta a una domanda vecchia, e nessun ordine di
 * arrivo la rende sbagliata — quindi non basta ordinare le letture, bisogna
 * ricordare cosa si sta scrivendo. Finché la PATCH non ha risposto la card
 * resta dove l'hai lasciata, qualunque lista atterri sotto.
 */
export function applyPendingWrites<T extends { id: string }>(
  rows: readonly T[],
  pending: ReadonlyMap<string, Partial<T>>,
): readonly T[] {
  if (pending.size === 0) return rows;
  return rows.map((row) => {
    const patch = pending.get(row.id);
    return patch ? { ...row, ...patch } : row;
  });
}

/** Raggruppa per stato e ordina ogni colonna. Una colonna per stato, sempre presente. */
export function groupByStatus<T extends OrderableTask & { status: TaskStatus }>(
  tasks: readonly T[],
  scope: OrderScope,
): Record<TaskStatus, T[]> {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as T[]])) as Record<TaskStatus, T[]>;
  for (const t of tasks) byStatus[t.status]?.push(t);
  const cmp = compareTasks(scope);
  for (const s of TASK_STATUSES) {
    byStatus[s].sort(s === 'review' ? compareReview : s === 'done' ? compareDone : cmp);
  }
  return byStatus;
}

/**
 * Chiave di inserimento fra due vicini: nessuna rinumerazione, una sola PATCH
 * per drop. SQLite ha affinità NUMERIC sulla colonna, quindi il float sopravvive.
 */
export function between(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return next! - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

/**
 * IN PROGRESS IS NOT A QUEUE, and putting a card there by hand used to be a
 * one-way trip. The dispatcher only ever picks up `status: "todo"`
 * (`server/services/task-dispatcher.ts`), so nothing collects In Progress: the
 * card sat there forever. Worse, leaving Todo cancels the dispatch already
 * queued for it (`onLeaveTodo`), so the gesture did not just fail to start the
 * work, it stopped work that was about to start (seen on 7b803a72).
 *
 * A human aiming a card at In Progress means "work on this", which is what Todo
 * does, so that is where the card goes, and the surface says so: a gesture that
 * silently lands somewhere else is the same black hole with a different shape.
 *
 * The predicate is `isAgentWorking`, NOT `assignedTopicId`. A card handed to a
 * human keeps its topic binding — `deliverToReviewBySystem` says so in as many
 * words, «Hand to the human: keep assigned_topic_id (a rejection resumes this
 * agent)» — so `assignedTopicId` is still set on the single most common card
 * there is, a delivered one. Guarding on it left exactly that card in the black
 * hole, silently. `dispatch_state` is the field that says whether a turn is
 * RUNNING, which is the only case where In Progress is the truth: that drop is
 * a hand-over of work already in flight, and Todo would be a lie about it.
 *
 * There are three doors into In Progress and this is the rule for all of them:
 * the column drag (`planDrop`), the drawer's "move to" menu, and the inline
 * composer at the foot of the column. A rule that only one door obeys is not a
 * rule, it is a fourth way to get the same card stuck.
 */
export function manualStatusTarget(
  wanted: TaskStatus,
  task: Pick<BoardTask, 'dispatchState'> | null,
): { status: TaskStatus; redirectedFrom?: TaskStatus } {
  // No task at all = a card being CREATED: nothing is running on it by
  // definition, so it always redirects.
  if (wanted === 'in_progress' && !isAgentWorking(task?.dispatchState)) {
    return { status: 'todo', redirectedFrom: 'in_progress' };
  }
  return { status: wanted };
}

/** Cosa scrivere dopo un drop, o null se il drop non cambia niente. */
export interface DropPlan {
  /**
   * The patch for the dragged card. It can be EMPTY: a redirected drop (see
   * `redirectedFrom`) on a card already where the redirect sends it has nothing
   * to write, and still has something to say.
   */
  patch: { status?: TaskStatus; kanbanOrder?: number };
  /**
   * Le ALTRE card della colonna da riscrivere, quando l'interstizio frazionario
   * si è esaurito e la sola patch non basta (vedi `planDrop`). Assente = il caso
   * normale, una PATCH e basta.
   */
  renumber?: { id: string; kanbanOrder: number }[];
  /**
   * The column the card was actually dropped on, when it did NOT end up there.
   * Present only for the In Progress redirect below. It is a FACT, not a
   * sentence: the words belong to the surface that draws the notice
   * (`KanbanBoardPane`), so this module stays pure ordering logic.
   */
  redirectedFrom?: TaskStatus;
}

/**
 * Cosa fa il rilascio di `task` sopra `overId`.
 *
 * `overId` è o l'id di una colonna (si è lasciata la card nel vuoto sotto le
 * altre → in fondo) o l'id di un'altra card (→ al suo posto).
 *
 * In `cross-project` la posizione non si tocca mai: si restituisce al più il
 * cambio di stato. Vedi la nota in testa al file.
 *
 * A drop on In Progress is REDIRECTED to Todo unless an agent is actually
 * working the card, and the plan declares it with `redirectedFrom`. The rule and
 * the reason live in `manualStatusTarget`.
 *
 * DUE LISTE, non una. Quella che si VEDE dice su quale card hai rilasciato;
 * quella INTERA dice fra quali numeri finisci. Con un filtro attivo erano la
 * stessa cosa, e la rinumerazione da interstizio esaurito riscriveva 1..N sulle
 * sole card visibili: le nascoste tenevano i vecchi numeri e la colonna si
 * rimescolava appena il filtro cadeva. Anche `between` sbagliava, più
 * silenziosamente — i vicini «giusti» erano quelli visibili, e la card atterrava
 * in mezzo a card che non aveva mai visto.
 */
export function planDrop(args: {
  task: BoardTask;
  overId: string | null;
  /** Le colonne COME SI VEDONO: filtri applicati. Sceglie l'ancora e l'indice. */
  byStatus: Record<TaskStatus, BoardTask[]>;
  /** Le colonne INTERE, filtri ignorati: `between` e `renumber` lavorano qui.
   *  Assente = nessun filtro attivo, le due liste coincidono. */
  byStatusAll?: Record<TaskStatus, BoardTask[]>;
  scope: OrderScope;
}): DropPlan | null {
  const { task, overId, byStatus, byStatusAll = byStatus, scope } = args;
  if (!overId || overId === task.id) return null;

  const isColumn = (TASK_STATUSES as readonly string[]).includes(overId);
  const overTask = isColumn ? undefined : findById(byStatus, overId);
  const dropStatus = (overTask ? overTask.status : overId) as TaskStatus;
  if (!(TASK_STATUSES as readonly string[]).includes(dropStatus)) return null;
  // Rilasciata su una card che non è in nessuna colonna nota (lista già cambiata
  // sotto le dita): non si inventa una posizione.
  if (!isColumn && !overTask) return null;

  // In Progress is not a queue: `manualStatusTarget` carries the whole rule and
  // the reason, and the drawer's "move to" menu and the inline composer obey
  // the same one.
  //
  // A card ALREADY in In Progress is exempt, whatever its dispatch state: it is
  // not asking to enter, it is being reordered, and answering a reorder with a
  // change of column turns a gesture that meant nothing into one that means a
  // lot. That is a regression this guard exists to hold, not a detail.
  const reorderInside = task.status === 'in_progress' && dropStatus === 'in_progress';
  const aim = reorderInside ? { status: dropStatus } : manualStatusTarget(dropStatus, task);
  const status: TaskStatus = aim.status;
  const redirectedFrom = aim.redirectedFrom;
  // A redirected drop is not a position: the card it was released on lives in
  // another column, so its place says nothing about where this one belongs. It
  // accodes at the end of Todo, and a card already in Todo does not move at all
  // (see below) — being aimed at another column is not a demotion.
  const anchor = redirectedFrom ? undefined : overTask;

  const sameColumn = task.status === status;

  // Redirected onto the column it is ALREADY in: nothing to write. The gesture
  // still owes an explanation, so the plan travels with an empty patch.
  if (redirectedFrom && sameColumn) return { patch: {}, redirectedFrom };

  // Board generale: la posizione non è scrivibile (kanbanOrder è per-progetto).
  // (A redirect that changes nothing already returned above, so here a same
  // column drop is a plain no-op.)
  if (scope === 'cross-project') {
    return sameColumn ? null : { patch: { status }, ...(redirectedFrom ? { redirectedFrom } : {}) };
  }

  // Review e Done si ordinano per data (vedi `compareReview` / `compareDone`):
  // una posizione scritta lì non si vedrebbe, e resterebbe appesa al task come
  // un numero derivato da vicini ordinati per tutt'altro — pronto a spostarlo
  // altrove quando la card torna in una colonna a mano. Ci si entra, non ci si
  // riordina.
  if (status === 'review' || status === 'done') return sameColumn ? null : { patch: { status } };

  // La colonna INTERA (vedi l'intestazione): l'ancora arriva dalla lista
  // visibile, ma il posto si conta fra tutte le card che quel numero lo hanno
  // davvero. Rilasciare nel vuoto significa «in fondo alla colonna», non «in
  // fondo a quello che sto guardando».
  const col = byStatusAll[status].filter((t) => t.id !== task.id); // già ordinata
  let idx = anchor ? col.findIndex((t) => t.id === anchor.id) : col.length;
  if (idx < 0) idx = col.length;
  // Spostamento verso il BASSO nella stessa colonna: rilasciare "sopra" una card
  // che stava sotto di noi significa finire DOPO di lei, nel posto che occupava.
  if (anchor && sameColumn && task.kanbanOrder < anchor.kanbanOrder) idx += 1;
  const prev = col[idx - 1]?.kanbanOrder;
  const next = col[idx]?.kanbanOrder;
  const kanbanOrder = between(prev, next);

  // Interstizio ESAURITO. `between` dimezza l'ampiezza a ogni inserimento nello
  // stesso punto, e dopo una cinquantina di drop consecutivi lì in mezzo i due
  // vicini sono numeri contigui: la media ricade su uno dei due e la card non ha
  // più un posto in cui stare. Senza questa via d'uscita il drag smetteva di
  // funzionare in silenzio — il caso peggiore, perché sembra un bug del mouse.
  // Si rinumera la colonna a interi: N patch invece di una, ma solo qui.
  if (kanbanOrder === prev || kanbanOrder === next) {
    const target = [...col.slice(0, idx), task, ...col.slice(idx)];
    const renumber = target
      .map((t, i) => ({ id: t.id, kanbanOrder: i + 1 }))
      .filter((r) => r.id !== task.id);
    return {
      patch: { ...(sameColumn ? {} : { status }), kanbanOrder: idx + 1 },
      renumber,
      ...(redirectedFrom ? { redirectedFrom } : {}),
    };
  }

  // Same column, same slot: nothing happened. (A redirect can never reach here,
  // it returned above.)
  if (sameColumn && kanbanOrder === task.kanbanOrder) return null;
  return {
    patch: sameColumn ? { kanbanOrder } : { status, kanbanOrder },
    ...(redirectedFrom ? { redirectedFrom } : {}),
  };
}

function findById(byStatus: Record<TaskStatus, BoardTask[]>, id: string): BoardTask | undefined {
  for (const s of TASK_STATUSES) {
    const hit = byStatus[s].find((t) => t.id === id);
    if (hit) return hit;
  }
  return undefined;
}
