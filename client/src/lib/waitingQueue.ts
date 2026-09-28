/**
 * ⌘J: which chats are waiting for you, in what order, and which one is next
 * (CHAT-WAIT-03). Pure, like the rest of the sidebar's builders: the sets come
 * from the caller, so the order is provable without a store or a socket.
 */
import {
  groupSidebarItemsByState,
  sidebarItemSubject,
  sidebarStateSignals,
  type SidebarItem,
  type SidebarSignalSources,
} from './buildSidebarItems';
import type { WaitingStep } from '../state/waitingQueue';

export interface WaitingTarget {
  /** Topic id for a chat, bare session id for a terminal. */
  subject: string;
  kind: 'chat' | 'terminal';
  /** The row, for the click handler: a detached window label, a name. */
  item: SidebarItem;
}

/**
 * A target is an AMBER row: a chat parked on a question or a permission (or
 * on a plan Claude Code asks to approve through its hooks), a Claude Code
 * terminal parked on a permission. The same predicate that picks the colour
 * (`useTopicAttentionTier`, `useTerminalAttentionTier` in signals.ts), so the
 * target and the colour cannot diverge. A finished turn (blue) is not a
 * target: it exists only for sessions with hooks. «Seen» does not count either:
 * a question you looked at is still open.
 */
function targetOf(item: SidebarItem, src: SidebarSignalSources): WaitingTarget | null {
  const subject = sidebarItemSubject(item);
  if (!subject) return null;
  if (item.type === 'chat' && src.awaitingInputTopics.has(subject)) return { subject, kind: 'chat', item };
  if (item.type === 'terminal' && src.claudePhaseAwaitingInputTermIds.has(subject)) return { subject, kind: 'terminal', item };
  return null;
}

/**
 * The targets in the order the sidebar shows them.
 *
 * 1. The pinned rows, in the Pinned block's order (`pinnedIds`), the ones the
 *    view draws at the top. A pinned PROJECT contributes the targets among its
 *    tabs, in its place: its band draws them there, and the list below leaves
 *    the pinned project out, so nowhere else would reach them.
 * 2. Then the «Attende te» section of the state view, which keeps the
 *    builder's order and promotes a project's children in the project's place.
 * 3. A subject appears once, at its first occurrence. The Pinned block takes a
 *    pinned child of a project while the state grouping promotes the same child
 *    without looking at `pinned`: without this a chat pinned inside a project
 *    would be queued twice, the door would count one chat too many, and a step
 *    from it would land on itself.
 *
 * Sub-agents nested under a chat or a terminal are not rows of either list, so
 * they are never targets.
 */
export function waitingQueue(
  items: SidebarItem[],
  pinnedIds: readonly string[],
  src: SidebarSignalSources,
): WaitingTarget[] {
  const out: WaitingTarget[] = [];
  const seen = new Set<string>();
  const take = (item: SidebarItem) => {
    const t = targetOf(item, src);
    if (!t || seen.has(t.subject)) return;
    seen.add(t.subject);
    out.push(t);
  };

  const pinnedById = new Map<string, SidebarItem>();
  for (const item of items) {
    if (item.pinned) pinnedById.set(item.id, item);
    for (const child of item.children ?? []) if (child.pinned) pinnedById.set(child.id, child);
  }
  for (const id of pinnedIds) {
    const item = pinnedById.get(id);
    if (!item) continue;
    if (item.type === 'project') for (const child of item.children ?? []) take(child);
    else take(item);
  }

  const unpinned = items.filter(i => !i.pinned);
  for (const item of groupSidebarItemsByState(unpinned, sidebarStateSignals(src)).awaiting) take(item);
  return out;
}

/**
 * The next target, or `null` when there is none other than the focused row.
 *
 * - The focused row is in the queue: the one after it, wrapping to the first.
 * - The focused row is where the previous step took you and has left the queue
 *   (you answered it): the first of the rows that followed it in that step's
 *   queue and are still waiting, else the first. Answering moves the row out
 *   of «Attende te» and, in the list, to a new place by activity: its new
 *   position says nothing, its position in the queue of before does.
 * - Otherwise the first.
 */
export function nextWaiting(
  queue: readonly string[],
  focused: string | null,
  last: WaitingStep | null,
): string | null {
  if (queue.length === 0) return null;
  const at = focused === null ? -1 : queue.indexOf(focused);
  if (at !== -1) return queue.length === 1 ? null : queue[(at + 1) % queue.length];
  if (last && focused === last.target) {
    const from = last.queue.indexOf(last.target);
    const still = new Set(queue);
    for (const s of last.queue.slice(from + 1)) if (still.has(s)) return s;
  }
  return queue[0];
}
