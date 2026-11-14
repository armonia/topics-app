import { TASK_STATUSES, type TaskStatus } from "./board";
import { awaitsHuman } from "./workflow";

/** Il minimo che serve alla tray: il contratto della card sta in `board.ts`,
 *  ma il guscio non ha bisogno di conoscerlo tutto per disegnare una riga. */
export interface TrayTaskInput {
  id: string;
  text: string;
  status: string;
  projectId: string;
  /** The workflow column (`shared/workflow.ts`): AI review is not a person's. */
  stage?: string | null;
}

/**
 * Il menu della tray, dal lato dei DATI.
 *
 * Oggi la tray dice solo le chat che aspettano una risposta. I task della board
 * non ci sono: per sapere che c'è una card in review si apre la app. Questa è la
 * parte che si può decidere e provare senza toccare il Rust — quale roba va nel
 * menu, in che ordine, con che etichetta — e sta qui, condivisa, per la stessa
 * ragione per cui ci sta il resto del contratto della board: il menu nativo lo
 * costruisce il guscio, ma COSA ci va dentro lo decide un posto solo.
 *
 * L'ordine dei gruppi NON è alfabetico e non è quello delle colonne: è quello
 * dell'urgenza per chi guarda una tray. Prima ciò che aspetta una decisione
 * (`review`), poi ciò che sta correndo (`in_progress`), poi la coda. `backlog` e
 * `done` non entrano: il primo non è lavoro in corso, il secondo è finito, e una
 * tray che elenca tutto smette di essere un richiamo e diventa una seconda board.
 */
export const TRAY_GROUP_ORDER = ["review", "in_progress", "todo"] as const;
export type TrayGroupStatus = (typeof TRAY_GROUP_ORDER)[number];

/** Quante righe per gruppo. Oltre, il menu diventa una lista da scorrere. */
export const TRAY_ROWS_PER_GROUP = 5;

export interface TrayRow {
  /** Il task da aprire col deep-link. */
  id: string;
  title: string;
  /** Il progetto, per la riga: due card omonime su board diverse capitano. */
  projectId: string;
}

/**
 * WHAT ASKS FOR A PERSON, by why: the lit `task:` subjects of the attention
 * state (review, a park to look at, a wait mid-turn), steps included. The
 * glyph's number, the board tab's number and the Plan count these, so the
 * menu lists them too: a review group read off the feed's roots said 3 while
 * the number next to it said 8 (the steps of parents sitting in backlog).
 */
export const TRAY_LIT_REASONS = ["review", "parked", "question"] as const;
export type TrayLitReason = (typeof TRAY_LIT_REASONS)[number];

/** One lit card as the menu needs it. */
export interface TrayLitCard {
  id: string;
  title: string;
  projectId: string;
  reason: TrayLitReason;
}

/** The attention reason of a lit card, folded to the menu's three: a permission or a plan is a question. */
export function trayLitReason(reason: string | null | undefined): TrayLitReason {
  return reason === "review" || reason === "parked" ? reason : "question";
}

export interface TrayGroup {
  status: TrayGroupStatus | TrayLitReason;
  /** TUTTI i task del gruppo, anche quelli che non entrano fra le righe. */
  count: number;
  rows: TrayRow[];
}

/** Un titolo che sta in una riga di menu, senza tagliare a metà una parola. */
export function trayTitle(text: string, max = 44): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const tagliato = t.slice(0, max - 1);
  const spazio = tagliato.lastIndexOf(" ");
  // Sotto i due terzi il taglio sulla parola perde troppo: meglio spezzare.
  return `${(spazio > max * 0.6 ? tagliato.slice(0, spazio) : tagliato).trimEnd()}…`;
}

/**
 * I task aperti raggruppati per stato, pronti per il menu.
 *
 * PURA e senza I/O: prende la stessa lista che alimenta i badge in-app
 * (`useGlobalBoard` / `boardTasksStore`) e la riduce. Un gruppo VUOTO non esce:
 * una voce «Review (0)» nel menu è rumore che si legge come un difetto.
 */
export function trayBoardGroups(
  tasks: readonly TrayTaskInput[],
  opts: { rowsPerGroup?: number; lit?: readonly TrayLitCard[] } = {},
): TrayGroup[] {
  const perGroup = Math.max(1, opts.rowsPerGroup ?? TRAY_ROWS_PER_GROUP);
  // With the lit cards in hand, what waits on a person comes from them (steps
  // included) and the feed's review group gives way: one list, one number.
  const out: TrayGroup[] = opts.lit ? trayLitGroups(opts.lit, { rowsPerGroup: perGroup }) : [];
  for (const status of TRAY_GROUP_ORDER) {
    if (opts.lit && status === "review") continue;
    // The review group is what waits on a PERSON: a card in AI review goes back
    // to whoever opened it, so it is not in the menu (`awaitsHuman`).
    const miei = tasks.filter((t) => (status === "review" ? awaitsHuman(t) : t.status === status));
    if (miei.length === 0) continue;
    out.push({
      status,
      count: miei.length,
      rows: miei.slice(0, perGroup).map((t) => ({
        id: t.id,
        title: trayTitle(t.text),
        projectId: t.projectId,
      })),
    });
  }
  return out;
}

/**
 * The lit cards grouped by why they wait, in `TRAY_LIT_REASONS` order, empty
 * groups left out. The same rows the number counts: the menu cannot list a
 * different board from the one the glyph and the tab say.
 */
export function trayLitGroups(
  cards: readonly TrayLitCard[],
  opts: { rowsPerGroup?: number } = {},
): TrayGroup[] {
  const perGroup = Math.max(1, opts.rowsPerGroup ?? TRAY_ROWS_PER_GROUP);
  const out: TrayGroup[] = [];
  for (const reason of TRAY_LIT_REASONS) {
    const mine = cards.filter((c) => c.reason === reason);
    if (mine.length === 0) continue;
    out.push({
      status: reason,
      count: mine.length,
      rows: mine.slice(0, perGroup).map((c) => ({ id: c.id, title: trayTitle(c.title), projectId: c.projectId })),
    });
  }
  return out;
}

/** Il totale che va sul glifo: le righe che chiedono qualcosa a un umano. */
export function trayBoardAttention(groups: readonly TrayGroup[]): number {
  return groups
    .filter((g) => (TRAY_LIT_REASONS as readonly string[]).includes(g.status))
    .reduce((n, g) => n + g.count, 0);
}

/** Gli stati che la tray NON mostra, dichiarati invece che dedotti dal filtro. */
export const TRAY_HIDDEN_STATUSES: readonly TaskStatus[] =
  TASK_STATUSES.filter((s): s is TaskStatus => !(TRAY_GROUP_ORDER as readonly string[]).includes(s));

/** The agents of the menu-bar strip, counted by state (card 066276b6). */
export interface TrayAgentStates {
  working: number;
  review: number;
  waiting: number;
  stopped: number;
}

/**
 * One criterion per state, the same words as the app's status glyphs:
 * working = subjects whose attention tier is `working`; review = the cards
 * that wait for a person's review; waiting = a question on a card or a chat
 * that needs an answer; stopped = a parked card or a chat that ended in error.
 */
export function trayAgentStates(
  groups: readonly TrayGroup[],
  subjects: { working: number; needsYou: number; error: number },
): TrayAgentStates {
  const of = (status: string) => groups.find((g) => g.status === status)?.count ?? 0;
  return {
    working: subjects.working,
    review: of("review"),
    waiting: of("question") + subjects.needsYou,
    stopped: of("parked") + subjects.error,
  };
}
