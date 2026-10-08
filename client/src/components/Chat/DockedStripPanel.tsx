/**
 * WHAT A STRIP OPENS, OPENS ABOVE ITS OWN HEADER.
 *
 * The strips (the todo list, the files this chat touched, the checkpoints, the
 * goal, the live work) are the last thing in the transcript, right above the
 * composer (chat-strips-in-transcript). Whatever they open unrolls ABOVE the
 * header, in the flow of the strip: the header is the strip's bottom line and
 * stays under the pointer, held there by the transcript's disclosure anchor
 * (`useDisclosureToggle`) while the body animates, and the panel takes its
 * room upward, in sight. Opened below the header, at the bottom of the
 * transcript, the panel would unroll under the composer, out of sight.
 *
 * Until 08/10 the strips sat in the block docked over the composer, where the
 * same rule held for the opposite reason: that block could only grow upward,
 * and a list opened under the header climbed it by its own height under the
 * pointer (measured in `tests/e2e/chat-accordion-no-shift.spec.ts`).
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
