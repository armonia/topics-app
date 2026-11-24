/**
 * THE CLOSED STATE OF A TAB: open, closed, archived.
 *
 * A tab the user closes does not vanish any more: it stays in the column as a
 * closed row, without the background an open tab has, until it is archived
 * (asked on 24/11: every kind of tab has three states, open, closed,
 * archived). Every kind of top-level tab gets
 * it: chats, projects, terminals, browsers, utility pages.
 *
 * The source is the closed-tab stack the pane store already keeps and syncs
 * across devices: each record carries what reopening needs (a terminal's
 * session, a browser's address, the slot the tab sat in). That makes one
 * source for every kind, where the topic's own `archived` flag only exists
 * for chats. The stack is bounded (`CLOSED_STACK_MAX`): past that the oldest
 * closed rows leave the column on their own, which is an archive by age, and
 * a chat that leaves that way is archived for real (`agedOutChats`), so it is
 * found in the archive and not lost between the two.
 *
 * A chat closed INSIDE a project window has the same three states: its record
 * (level `project`) keeps it under its project as a closed row
 * (`closedProjectChatIds`). The other kinds inside a project window keep their
 * own model.
 */
import type { ClosedTabRecord } from '../state/pane/adapters/closedTabRecord';
import { isUtilityPanelId, parseUtilityPanelType } from '../state/pane/adapters/utilityPanelId';
import type { Topic } from '../types';

/** Utility pages that have a dedicated row of their own, or none at all: the
 *  same list the column skips for an open utility tab (buildSidebarItems §5b). */
const UTILITY_PAGES_WITHOUT_ROW = new Set(['board', 'automations', 'agents', 'system-page', 'features']);

/**
 * The records that stand for a closed row, newest first, one per tab.
 *
 * Out: tabs that are open again, records of tabs inside a project window, a
 * chat that is archived or unknown (the boot list holds the live chats only,
 * so an unknown one is archived or deleted), the global coordinator (its pane
 * is local and never enters the close lifecycle), utility pages without a row.
 */
export function closedRowRecords(
  closedTabs: readonly ClosedTabRecord[],
  { openIds, topics }: { openIds: ReadonlySet<string>; topics: Readonly<Record<string, Topic>> },
): ClosedTabRecord[] {
  const seen = new Set<string>();
  const out: ClosedTabRecord[] = [];
  const newestFirst = [...closedTabs].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  for (const record of newestFirst) {
    if (record.level !== 'app' || !record.pane) continue;
    const id = record.pane.id;
    if (!id || seen.has(id) || openIds.has(id)) continue;
    if (record.pane.type === 'chat') {
      const topic = topics[record.pane.topicId ?? id];
      if (!topic || topic.archived || topic.isGlobalOrchestrator) continue;
    }
    if (isUtilityPanelId(id) && UTILITY_PAGES_WITHOUT_ROW.has(parseUtilityPanelType(id) ?? '')) continue;
    seen.add(id);
    out.push(record);
  }
  return out;
}

/** The chat a record stands for: its topic id, whatever form the pane id has. */
function recordTopicId(record: ClosedTabRecord): string | undefined {
  if (record.pane?.type !== 'chat') return undefined;
  return record.topicId ?? record.pane.topicId ?? (record.pane.id.startsWith('chat:') ? record.pane.id.slice(5) : record.pane.id);
}

/**
 * The chats closed inside a project window that stay as closed rows under
 * their project: a live, not archived chat whose tab is not open again
 * (`openIds` holds every open pane id, top-level and inside the windows).
 */
export function closedProjectChatIds(
  closedTabs: readonly ClosedTabRecord[],
  { openIds, topics }: { openIds: ReadonlySet<string>; topics: Readonly<Record<string, Topic>> },
): Set<string> {
  const out = new Set<string>();
  for (const record of closedTabs) {
    if (record.level !== 'project') continue;
    const id = recordTopicId(record);
    const topic = id ? topics[id] : undefined;
    if (!id || !topic || topic.archived || topic.isGlobalOrchestrator) continue;
    if (openIds.has(id) || openIds.has(`chat:${id}`)) continue;
    out.add(id);
  }
  return out;
}

/**
 * The chats whose closed record just fell off the bounded stack: the oldest
 * records the FIFO dropped between `prev` and `next`, minus a chat that still
 * has a newer record. Only a FIFO step counts (`next` starts with what is left
 * of `prev`): a whole snapshot from another device is not an eviction.
 */
export function agedOutChats(prev: readonly ClosedTabRecord[], next: readonly ClosedTabRecord[], cap: number): string[] {
  if (prev.length < cap || next.length < cap || prev === next) return [];
  const dropped = prev.length - (next.length - countNew(prev, next));
  // Nothing in common is a replaced stack, not a step of the FIFO.
  if (dropped <= 0 || dropped >= prev.length) return [];
  const kept = prev.slice(dropped);
  if (kept.some((r, i) => r.id !== next[i]?.id || r.closedAt !== next[i]?.closedAt)) return [];
  const stillClosed = new Set(next.map(recordTopicId).filter(Boolean));
  const out: string[] = [];
  for (const record of prev.slice(0, dropped)) {
    const id = recordTopicId(record);
    if (id && !stillClosed.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** How many records at the end of `next` are not in `prev`. */
function countNew(prev: readonly ClosedTabRecord[], next: readonly ClosedTabRecord[]): number {
  const known = new Set(prev.map((r) => `${r.id}@${r.closedAt}`));
  let n = 0;
  for (let i = next.length - 1; i >= 0 && !known.has(`${next[i].id}@${next[i].closedAt}`); i--) n++;
  return n;
}

/** What the row command does: an open tab closes, a closed one archives. */
export type RowCommand = 'close' | 'archive' | 'restore';

export function rowCommand({ open, archived }: { open: boolean; archived: boolean }): RowCommand {
  if (archived) return 'restore';
  return open ? 'close' : 'archive';
}

/**
 * Close one pane inside a project window from outside it (a nested row of the
 * column). The window whose project matches closes the first of `paneIds` it
 * holds and calls `preventDefault()`; nobody claiming it means the project
 * window is not mounted.
 */
export const CLOSE_PROJECT_INNER_PANE_EVENT = 'close-project-inner-pane';
export interface CloseProjectInnerPaneDetail { projectPath: string; paneIds: string[] }
