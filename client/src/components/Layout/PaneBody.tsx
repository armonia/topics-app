import { memo, type ReactNode } from 'react';
import type { Pane } from '../../types';

/**
 * One pane body, rendered only when what it is rendered FROM changes.
 *
 * `renderPane` is the host's (ProjectWindow memoises it on the data the panes
 * show, not on the layout), `pane` is the pane record, the two flags are the
 * pane's own state. A resize, a split, a move, a swap re-render the whole
 * layout and change none of the four, so the body is skipped. Before this,
 * every commit of the layout re-rendered every visible body for props that had
 * not changed (split-reorg-budget.spec.ts reports the counts per gesture).
 */
export const PaneBody = memo(function PaneBody({ render, pane, focused, visible }: {
  render: (pane: Pane, isFocused: boolean, isVisible: boolean) => ReactNode;
  pane: Pane;
  focused: boolean;
  visible: boolean;
}) {
  return <>{render(pane, focused, visible)}</>;
});
