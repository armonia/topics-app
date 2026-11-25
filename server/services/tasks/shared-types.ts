import { type CardComment, type BlockerRef, type QueueContext } from "../../../shared/board";
import { type TaskLabelRow } from "../../../shared/task-labels";

/**
 * LA FILA, ORDINATA UNA VOLTA SOLA invece di contata due volte per riga.
 *
 * `countAhead`/`countBehind` erano due COUNT correlati per ogni card in
 * `todo`: su una board con Q task in coda la lista costava O(Q²) scansioni, e
 * il feed globale del 15/08 (467 radici) ne pagava ~200 da solo.
 *
 * Qui l'insieme idoneo si legge UNA volta, già ordinato con la disciplina del
 * tick (priorità prima, anzianità a parità), e la posizione di ogni card si
 * trova con una ricerca binaria. Stesso insieme, stessi predicati, stesso
 * confronto: le due `COUNT` erano il conto degli elementi PRIMA e DOPO questa
 * chiave, che è esattamente ciò che il lower/upper bound restituisce.
 *
 * Le lines con la STESSA coppia (priorità, creazione) non sono né davanti né
 * dietro, come prima: `countBehind` chiedeva `created_at > ?`, quindi la
 * parità era già esclusa da entrambi i versi e l'`id != ?` era ridondante.
 */
export interface QueueRank {
  ahead(priority: number, createdAt: string): number;
  behind(priority: number, createdAt: string): number;
}


/**
 * I fatti che `rowToTask` andava a chiedere UNA RIGA ALLA VOLTA, letti una
 * volta per lotto.
 *
 * Misurato il 15/08 su `GET /api/all-boards/tasks` (467 radici, DB da
 * 651 MB): da 4 a 7 statement per riga — etichette, bloccante, topic per
 * modello ed effort, dipendenti, stato del padre, impostazioni della board, e
 * per ogni `todo` i due COUNT della fila — cioè ~1.500 statement e 145 ms per
 * una lista sola. Qui sono ~10, indipendenti dal numero di lines.
 *
 * `rowToTask` resta la porta UNICA (ci passano anche update, claim e release,
 * che il server ribalta sul WS): è implementata come un lotto da una riga, così
 * i due percorsi non possono divergere sul contenuto del payload.
 */
export interface TaskBatch {
  nowIso: string;
  labels: Map<string, TaskLabelRow[]>;
  waitingOn: Map<string, number>;
  topics: Map<string, { model: string | null; effort: string | null }>;
  blockers: Map<string, BlockerRef>;
  parentStatus: Map<string, string>;
  retryCap: Map<string, number>;
  openChildren: Map<string, number>;
  comments: Map<string, CardComment[]>;
  /** Cards whose last word in the thread is an unanswered question. */
  awaiting: Set<string>;
  /** Le altre evidenze del thread, per il carosello della card. */
  previewImages: Map<string, string[]>;
  queue: QueueRank | null;
  /**
   * The NAME of every node a card in this batch names. The chip has to say
   * which machine went silent, and an id in that sentence names nothing to
   * whoever reads it. Empty when no row names a node: a board of local cards
   * pays no read at all.
   */
  nodeNames: Map<string, string>;
  /** Where an In-progress card with no agent here works (`task-elsewhere.ts`). */
  elsewhere: Map<string, NonNullable<QueueContext["elsewhere"]>>;
  peopleNames: Map<string, string>;
  deviceNames: Map<string, string>;
  autoDispatch: boolean;
  heavy: boolean;
  /**
   * Il DB non sa rispondere sulla coda (schema ridotto di un test,
   * `board_settings` assente): la ragione si dichiara `unknown` invece di
   * ricadere sul chip «in coda», che è proprio la parola vaga che quel campo
   * esiste per togliere. Stessa scelta del `catch` che questo sostituisce.
   */
  queueReadable: boolean;
}
