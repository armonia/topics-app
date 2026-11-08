import { Activity, useState, type ReactNode } from 'react';

/**
 * A collapsible section of the project sidebar that keeps what it holds when it
 * is closed. Closed is `Activity` hidden: the tree is not painted and its
 * effects are released, but its state (scroll position, selection, expanded
 * folders) stays, so opening it again lands where it was left instead of on a
 * fresh mount.
 *
 * A section that was never opened is not mounted at all: a project whose
 * Processes section stays closed does not pay for polling its scripts.
 */
export function KeptSection({ open, children }: { open: boolean; children: ReactNode }) {
  const [everOpened, setEverOpened] = useState(open);
  // Derived during render, the documented way to adjust state to a prop change.
  if (open && !everOpened) setEverOpened(true);
  if (!everOpened) return null;
  return <Activity mode={open ? 'visible' : 'hidden'}>{children}</Activity>;
}
