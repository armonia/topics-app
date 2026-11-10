import type { KeyboardEvent } from 'react';

/** The focus ring every pressable control of the layer wears. */
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

/**
 * Makes a non-button element pressable from the keyboard. Nothing is added
 * without a handler, so a picture of the sidebar has no tab stops. Only keys
 * pressed on the element itself count: a control nested inside keeps its own.
 */
export function pressable(onClick?: () => void) {
  if (!onClick) return {};
  return {
    tabIndex: 0,
    onClick,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
}
