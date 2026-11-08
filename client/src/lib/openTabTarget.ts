/**
 * WHERE a link-opened browser tab lands - the rule, once, as a pure function.
 *
 * The two surfaces that can host a browser pane (the project window and the
 * standalone group) had already grown two copies of "open a browser here", and
 * they had drifted. This one is written once and unit-tested, and both handlers
 * call it before touching any state.
 *
 * The rule, in order:
 *  1. The click came FROM a pane (a terminal, a browser page opening a popup):
 *     the tab belongs in that pane's group. It is a plain tab there when that
 *     group already shows a browser (a strip that gains one more tab, Chrome
 *     style), and a split when it does not (a terminal group gets its browser
 *     beside it, exactly as today's `browser:open-and-navigate` does).
 *  2. No origin pane, but this window already has a browser somewhere: the tab
 *     joins THAT strip. This is what makes the second, third and tenth link
 *     from a chat pile up as tabs instead of tiling a new cell each time.
 *  3. Nothing to attach to: the focused group, split out beside the chat.
 *
 * The tab is inserted right AFTER the group's active pane, not appended: a tab
 * opened from the tab you are on shows up next to it, which is where every
 * browser puts it.
 */

import type { PaneGroup } from '../types';

/** The minimum a caller has to know about a pane for this decision. */
export interface TabTargetPane {
  id: string;
  type: string;
}

export interface OpenTabTargetInput {
  /** Pane the link was clicked in, when there is one. */
  nearPaneId?: string;
  panes: TabTargetPane[];
  groups: Pick<PaneGroup, 'id' | 'paneIds' | 'activePaneId'>[];
  focusedGroupId?: string | null;
}

export interface OpenTabTarget {
  /** Group that hosts the new tab, or undefined when the window has no group
   *  at all (the caller then creates group + pane together). */
  groupId?: string;
  /** True when the new pane must be split out into its own cell instead of
   *  staying a tab of `groupId`. */
  split: boolean;
  /** Pane the new tab is inserted after, or undefined to append. */
  afterPaneId?: string;
}

function groupOf(
  groups: OpenTabTargetInput['groups'],
  paneId: string,
): OpenTabTargetInput['groups'][number] | undefined {
  return groups.find((g) => g.paneIds.includes(paneId));
}

function hasBrowser(
  group: OpenTabTargetInput['groups'][number],
  panes: TabTargetPane[],
): boolean {
  return group.paneIds.some((id) => panes.some((p) => p.id === id && p.type === 'browser'));
}

export function resolveOpenTabTarget(input: OpenTabTargetInput): OpenTabTarget {
  const { nearPaneId, panes, groups, focusedGroupId } = input;

  const near = nearPaneId ? groupOf(groups, nearPaneId) : undefined;
  if (near) {
    return {
      groupId: near.id,
      split: !hasBrowser(near, panes),
      afterPaneId: near.activePaneId || nearPaneId,
    };
  }

  // Prefer a browser already in the focused group, so a window with two strips
  // grows the one the user is looking at.
  const browserPanes = panes.filter((p) => p.type === 'browser');
  const focused = focusedGroupId ? groups.find((g) => g.id === focusedGroupId) : undefined;
  const inFocused =
    focused && browserPanes.find((p) => focused.paneIds.includes(p.id));
  const anywhere = inFocused ?? browserPanes.find((p) => !!groupOf(groups, p.id));
  if (anywhere) {
    const g = groupOf(groups, anywhere.id);
    if (g) return { groupId: g.id, split: false, afterPaneId: g.activePaneId || anywhere.id };
  }

  const fallback = focused ?? groups[0];
  return {
    groupId: fallback?.id,
    split: !!fallback,
    afterPaneId: fallback?.activePaneId,
  };
}

/**
 * Put `paneId` right after `afterPaneId` in a group's tab order.
 *
 * Pure and defensive on purpose: the pane may already be at the end (the
 * creation seam appends), the anchor may have been closed in the same tick, and
 * both cases have to leave a valid order rather than throw.
 */
export function insertPaneAfter(
  paneIds: string[],
  paneId: string,
  afterPaneId?: string,
): string[] {
  const without = paneIds.filter((id) => id !== paneId);
  if (!afterPaneId || afterPaneId === paneId) return [...without, paneId];
  const at = without.indexOf(afterPaneId);
  if (at < 0) return [...without, paneId];
  return [...without.slice(0, at + 1), paneId, ...without.slice(at + 1)];
}
