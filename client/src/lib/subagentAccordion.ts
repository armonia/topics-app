/**
 * The sub-agents under a parent row sit in an accordion that starts CLOSED.
 * Attilio, 05/10: «dovrebbe esserci una accordion sulla tab principale da allow-italian: verbatim quote from Attilio
 * essere chiusa di default e non essere "attiva" fino a che non interagisci». allow-italian: verbatim quote from Attilio
 *
 * The header says how many children there are and whether one is working;
 * it opens only on a click, or by itself while one of the children is the
 * row in front (otherwise the person would lose the row they are on).
 * The open state is remembered per parent in localStorage: a convenience,
 * so every read and write survives storage being unavailable.
 */
import type { SidebarItem } from './buildSidebarItems';

const STORAGE_KEY = 'topics.subagents-open';

export interface SubagentSummary {
  /** Every descendant, nested ones included. */
  count: number;
  /** At least one descendant is working right now. */
  working: boolean;
  /** One of them is the focused row. */
  holdsFocus: boolean;
}

export function summarizeSubagents(
  children: readonly SidebarItem[],
  isWorking: (item: SidebarItem) => boolean,
  isFocused: (item: SidebarItem) => boolean,
): SubagentSummary {
  let count = 0;
  let working = false;
  let holdsFocus = false;
  const stack = [...children];
  while (stack.length) {
    const item = stack.pop()!;
    count += 1;
    if (!working && isWorking(item)) working = true;
    if (!holdsFocus && isFocused(item)) holdsFocus = true;
    if (item.subAgents?.length) stack.push(...item.subAgents);
  }
  return { count, working, holdsFocus };
}

/** Open when the person opened it, or while a child is the focused row. */
export function isAccordionOpen(parentId: string, opened: ReadonlySet<string>, summary: Pick<SubagentSummary, 'holdsFocus'>): boolean {
  return opened.has(parentId) || summary.holdsFocus;
}

export function readOpenedAccordions(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeOpenedAccordions(opened: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...opened]));
  } catch {
    // Private window or blocked storage: the accordion just starts closed next time.
  }
}

export function toggledAccordions(opened: ReadonlySet<string>, parentId: string): Set<string> {
  const next = new Set(opened);
  if (next.has(parentId)) next.delete(parentId);
  else next.add(parentId);
  return next;
}
