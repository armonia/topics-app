import type { KeyboardEvent } from 'react';

/**
 * What every floating surface of the kit shares: its plane, its look and the
 * way it takes focus. The values mirror the product's `lib/popoverStyles.ts`
 * and `lib/modalStyles.ts` (that module is not on the layer's pure list, so the
 * numbers are restated here, not imported).
 */

/** Menus, popovers, toasts: above the page, below a modal. */
export const LAYER_FLOAT = 'z-[9999]';
/** Dialogs and the command palette: above every popover. */
export const LAYER_MODAL = 'z-[10000]';

/** The frosted card of a menu or popover, with the shared 90ms entrance. */
export const FLOAT_SURFACE = 'glass-surface rounded-lg border border-app-border shadow-lg popover-enter';

/** The dimmed veil behind a modal surface, fading in with it. */
export const MODAL_VEIL = 'absolute inset-0 bg-black/30 backdrop-blur-[2px] modal-backdrop-enter dark:bg-black/50';

/**
 * A ref callback that focuses the element once it is mounted, without
 * scrolling the page to it. Module level, so its identity never changes and
 * React calls it on mount only, not on every render.
 */
export function focusOnMount(el: HTMLElement | null) {
  el?.focus({ preventScroll: true });
}

/**
 * Focuses a surface on mount unless something inside it already took focus
 * (an `autoFocus` field, a confirm button): children mount first, so their
 * focus is already in place when this runs. Keys pressed afterwards bubble
 * through the surface, which is how Escape reaches its `onKeyDown`.
 */
export function focusSurface(el: HTMLElement | null) {
  if (el && !el.contains(el.ownerDocument.activeElement)) el.focus({ preventScroll: true });
}

/** Focuses the first enabled item of a menu once it is mounted. */
export function focusFirstItem(el: HTMLElement | null) {
  if (!el) return;
  const first = menuItems(el)[0];
  (first ?? el).focus({ preventScroll: true });
}

/** Keeps the highlighted row of a list in view as the arrows move it. */
export function revealOnMount(el: HTMLElement | null) {
  el?.scrollIntoView({ block: 'nearest' });
}

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

function menuItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

/**
 * The keyboard of a menu: arrows, Home and End move focus between the enabled
 * items (wrapping at the ends), Escape and Tab close it. Returns whether the
 * key was handled.
 */
export function handleMenuKeys(e: KeyboardEvent<HTMLElement>, onClose: () => void): boolean {
  if (e.key === 'Escape' || e.key === 'Tab') {
    if (e.key === 'Escape') e.preventDefault();
    e.stopPropagation();
    onClose();
    return true;
  }
  const items = menuItems(e.currentTarget);
  if (!items.length) return false;
  const at = items.indexOf(e.target as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === 'ArrowUp') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next < 0) return false;
  e.preventDefault();
  items[next].focus({ preventScroll: true });
  return true;
}
