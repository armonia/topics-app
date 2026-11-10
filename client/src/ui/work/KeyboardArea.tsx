import type { KeyboardEvent, ReactNode } from 'react';
import { focusOnMount } from '../primitives/overlay';

/**
 * A region that listens for the keys of its screen (J and K move, Enter
 * confirms, E corrects) without a listener on the window: it takes focus when
 * it opens, so the keys land here, and it lets a control keep its own keys:
 * Enter on a button does what the button does, and typing in a field is never
 * taken. `onKey` receives the lowercase key, whether the key was pressed on a control, and whether that control is the selected row of a list; it says whether it used the key.
 */
export function KeyboardArea({ onKey, children, className, label }: {
  onKey: (key: string, on: { control: boolean; selectedRow: boolean }) => boolean;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const handle = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
    const onControl = Boolean(target.closest('button, a, [role="button"], [role="tab"], [role="radio"], [role="row"]')) && target !== e.currentTarget;
    const selectedRow = Boolean(target.closest('li[aria-selected="true"]'));
    if (onKey(e.key.length === 1 ? e.key.toLowerCase() : e.key, { control: onControl, selectedRow })) e.preventDefault();
  };
  return (
    <div ref={focusOnMount} tabIndex={-1} role="group" aria-label={label} onKeyDown={handle} className={className ?? 'flex h-full min-h-0 flex-col outline-none'}>
      {children}
    </div>
  );
}
