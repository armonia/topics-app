/**
 * THE CLOSED STATE OF A TAB: open, closed, archived.
 *
 * A tab the user closes does not vanish any more: it stays in the column as a
 * closed row, without the background an open tab has, until it is archived
 * (24/11: «hanno tutte 3 stati aperto-chiuso-archiviato», «tutti i tipologie
 * di tab dovrebbero avere il triplo stato»). Every kind of top-level tab gets
 * it: chats, projects, terminals, browsers, utility pages.
 *
 * The source is the closed-tab stack the pane store already keeps and syncs
 * across devices: each record carries what reopening needs (a terminal's
 * session, a browser's address, the slot the tab sat in). That makes one
 * source for every kind, where the topic's own `archived` flag only exists
 * for chats. The stack is bounded (`CLOSED_STACK_MAX`): past that the oldest
 * closed rows leave the column on their own, which is an archive by age.
 *
 * Tabs inside a project window keep their own model; only the top-level tabs,
 * the ones the strip and the column list, are covered here.
 */
import type { ClosedTabRecord } from '../state/pane/adapters/closedTabRecord';
import { isUtilityPanelId, parseUtilityPanelType } from '../state/pane/adapters/utilityPanelId';
import type { Topic } from '../types';

/** Utility pages that have a dedicated row of their own, or none at all: the
 *  same list the column skips for an open utility tab (buildSidebarItems §5b). */
const UTILITIES_WITHOUT_ROW = new Set(['board', 'automations', 'agents', 'system-page', 'features']);

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
  for (const rec of newestFirst) {
    if (rec.level !== 'app' || !rec.pane) continue;
    const id = rec.pane.id;
    if (!id || seen.has(id) || openIds.has(id)) continue;
    if (rec.pane.type === 'chat') {
      const topic = topics[rec.pane.topicId ?? id];
      if (!topic || topic.archived || topic.isGlobalOrchestrator) continue;
    }
    if (isUtilityPanelId(id) && UTILITIES_WITHOUT_ROW.has(parseUtilityPanelType(id) ?? '')) continue;
    seen.add(id);
    out.push(rec);
  }
  return out;
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
