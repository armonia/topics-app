/**
 * The dashboard's pure computations (queue, age, axis top), outside the
 * components file because fast refresh wants only components there.
 */
import type { BoardTask } from '../../lib/board';
import { WAITING_MEMORY_REASON } from '../../../../shared/board';
import { queueReasonText } from '../../../../shared/queue-reason-text';

/** A queued card, as the row draws it. */
export interface QueuedCard {
  id: string;
  title: string;
  /** The card's project, by name; `null` = unknown. */
  project: string | null;
  /** Milliseconds it has been waiting (since the last update). */
  waitingMs: number;
  /** Neutral phrase decided by the server, already translated; `null` = the server has none. */
  reason: string | null;
  /** The longer explanation, kept out of the row (tooltip only): one reason per state. */
  detail?: string | null;
  /** Waits only for free memory: the one wait Start anyway can skip. */
  memoryWaiter: boolean;
  /** The server considers it stuck (tone `stalled`): it does not start by itself. */
  stalled: boolean;
  projectId: string;
}

/** The cards waiting for a seat, in the order the dispatcher serves them. */
export function queuedCards(
  tasks: readonly BoardTask[],
  tr: (k: string, p?: Record<string, string | number>) => string,
  now: number,
  projectName: (t: BoardTask) => string | null = () => null,
): QueuedCard[] {
  return tasks
    .filter((t) => !t.parentTaskId && (t.dispatchState === 'queued' || t.dispatchState === 'waiting'))
    // The dispatcher's queue discipline (task-dispatcher, the tick): priority first,
    // then the oldest. It is the order they will start in, and "1st" is
    // the one Start anyway goes to.
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
    .map((t) => {
      const text = t.queueReason ? queueReasonText(t.queueReason, tr) : null;
      return {
        id: t.id,
        title: t.text,
        project: projectName(t),
        waitingMs: Math.max(0, now - Date.parse(t.updatedAt)),
        reason: text ? text.head : null,
        detail: text ? text.detail : null,
        // The same test as the server (`isMemoryWaiter`): outside it the server answers 409.
        memoryWaiter: t.status === 'todo' && t.dispatchState === 'queued' && t.dispatchError === WAITING_MEMORY_REASON,
        stalled: t.queueReason?.tone === 'stalled',
        projectId: t.projectId,
      };
    });
}

/** "19 min" / "2 h 5 min": how long it has waited, never a timestamp. */
export function waitingLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** The axis top: at least 6 GB, then the multiple of 3 above the max, so a large Mac does not squash the curve at the top. */
export function chartMax(values: readonly number[], startGB: number | null): number {
  const top = Math.max(6, startGB ?? 0, ...values);
  return top <= 6 ? 6 : Math.ceil(top / 3) * 3;
}

/** A card stopped by a real fault, as the red box lists it. */
export interface BrokenCard {
  id: string;
  /** Short title, one line: the box is narrow. */
  title: string;
  projectId: string;
}

/** How many stopped cards the red box names before "+N". */
export const MAX_BROKEN_LISTED = 3;
const SHORT_TITLE_CHARS = 40;

/** One line, cut with an ellipsis: enough to recognise the card, not to read it. */
export function shortTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= SHORT_TITLE_CHARS ? one : `${one.slice(0, SHORT_TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * The cards parked by a real fault (the dispatcher's `failed`, or `blocked` =
 * configuration to fix; a wait is not one). `total` is the true count, `listed`
 * the first {@link MAX_BROKEN_LISTED}, `more` the ones left out.
 */
export function brokenCards(tasks: readonly BoardTask[]): { total: number; listed: BrokenCard[]; more: number } {
  const all = tasks.filter((t) => !t.parentTaskId && t.status !== 'done' && (t.dispatchState === 'failed' || t.dispatchState === 'blocked'));
  return {
    total: all.length,
    listed: all.slice(0, MAX_BROKEN_LISTED).map((t) => ({ id: t.id, title: shortTitle(t.text), projectId: t.projectId })),
    more: Math.max(0, all.length - MAX_BROKEN_LISTED),
  };
}
