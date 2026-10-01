/**
 * WHAT A STRIP ABOVE THE COMPOSER OPENS, FLOATS ABOVE IT.
 *
 * The strips docked over the composer (the todo list, the files this chat
 * touched, the checkpoints) used to open in place, in the flow of the block
 * at the bottom of the pane. That block is docked to the bottom edge, so it can
 * only grow upward: the header that was clicked climbed by the height of the
 * list it opened, and the composer's taller block re-pinned the whole
 * transcript above it (measured in `tests/e2e/chat-accordion-no-shift.spec.ts`).
 *
 * Here the list opens as a panel standing on the strip, over the bottom of the
 * transcript, the way a menu opens over a page: the strip keeps its height,
 * the header stays under the pointer, the composer and the conversation do not
 * move. The panel takes the strip's width and the shared popover surface and
 * entrance (`POPOVER_PANEL`), and the strip it stands on is its `relative`
 * parent. Nothing is lost: closing it shows the transcript again where it was.
 */
import type { ReactNode } from 'react';
import { POPOVER_PANEL } from '../../lib/popoverStyles';

export function DockedStripPanel({ open, children, className, testId, id }: {
  open: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
  id?: string;
}) {
  if (!open) return null;
  return (
    <div
      id={id}
      data-testid={testId}
      data-docked-strip-panel="true"
      className={`absolute bottom-full left-0 right-0 z-20 mb-1 ${POPOVER_PANEL} ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
