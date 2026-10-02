/**
 * WHAT A STRIP ABOVE THE COMPOSER OPENS, OPENS ABOVE ITS OWN HEADER.
 *
 * The strips docked over the composer (the todo list, the files this chat
 * touched, the checkpoints, the goal) sit in the block docked to the bottom
 * edge of the pane, so whatever they open can only grow upward. Opened below
 * the header, as they used to, the header climbed by the height of the list
 * under the pointer (measured in `tests/e2e/chat-accordion-no-shift.spec.ts`).
 *
 * Here the list unrolls ABOVE the header, in the flow of the strip: the header
 * is the strip's bottom line and stays under the pointer. The block gets
 * taller, and the transcript, which reserves the block's height below its last
 * row, keeps its newest row right above the strip when it was following the
 * bottom (the composer's own resize pin, frame by frame while the body
 * animates); a transcript read further up does not move. A panel floating
 * over the transcript instead kept everything still but hid the newest output
 * under it while the agent was writing.
 *
 * Same body as every fold (`DisclosureBody`): height animated, nothing under
 * reduced motion. A rule under the list separates it from the header.
 */
import type { ReactNode } from 'react';
import { DisclosureBody } from './DisclosureBody';

export function DockedStripPanel({ open, children, className, testId, id }: {
  open: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
  id?: string;
}) {
  return (
    <DisclosureBody open={open} id={id} testId={testId} className={`border-b border-app-border/50 ${className ?? ''}`}>
      {children}
    </DisclosureBody>
  );
}
