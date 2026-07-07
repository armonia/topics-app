import { useEffect, useRef } from 'react';

/**
 * useDismissable — ONE dismissal contract for every custom menu / dropdown /
 * popover in the app: outside-pointer close, Escape close, and focus-restore to
 * the trigger. Before this hook each call-site hand-rolled its own listener,
 * diverging on three axes that caused real bugs:
 *   - `mousedown` (bubble) vs `pointerdown` (capture): the Settings sheet's
 *     mousedown→focus cycle could swallow a bubble listener, so a menu opened
 *     over it wouldn't close on outside click. Capture-phase `pointerdown` wins
 *     the race and also covers mouse+touch+pen in one listener.
 *   - Escape: many menus never handled it at all.
 *   - focus-restore: none restored focus to the trigger, so keyboard users lost
 *     their place on close.
 *
 * Contract:
 *   - pointerdown (capture) OR touchstart outside every ref in `refs` → onClose.
 *   - keydown Escape (capture, stopPropagation) → onClose.
 *   - on the open→closed transition, if focus is still INSIDE the menu (or
 *     nowhere), return it to the trigger. If the user already moved focus
 *     elsewhere (outside click, tabbed away), leave it — never yank focus back.
 *
 * `refs` lists every node that counts as "inside" — the trigger AND the panel,
 * plus any sub-panels (rename fields, nested menus) that portal elsewhere.
 * `refs[0]` is treated as the trigger for focus-restore.
 */
export interface UseDismissableOptions {
  open: boolean;
  onClose: () => void;
  /** Nodes that must NOT trigger dismissal. refs[0] is the focus-restore trigger. */
  refs: Array<React.RefObject<HTMLElement | null>>;
  /** Return focus to the trigger on close (default true). Skipped when the user
   *  has already moved focus outside the menu. */
  restoreFocus?: boolean;
}

export function useDismissable({ open, onClose, refs, restoreFocus = true }: UseDismissableOptions): void {
  // Latest values without re-subscribing the document listeners each render.
  const onCloseRef = useRef(onClose);
  const refsRef = useRef(refs);
  // Mirror in an effect (NOT during render) so the react-hooks/refs rule holds:
  // both are read only inside the effects/handlers below, which run after this
  // mirror commits. Declared first so it wins the commit-order race against the
  // `[open]` effect that reads refsRef.current synchronously on open.
  useEffect(() => {
    onCloseRef.current = onClose;
    refsRef.current = refs;
  });

  // Element focused when the menu opened — the focus-restore target.
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) return;
    // Snapshot the trigger: the element the user activated (activeElement at
    // open) is the truest restore target; fall back to the declared trigger.
    triggerRef.current =
      (document.activeElement as HTMLElement | null) ?? refsRef.current[0]?.current ?? null;

    const inside = (t: Node): boolean => refsRef.current.some((r) => !!r.current?.contains(t));

    const onPointer = (e: Event) => {
      const t = e.target as Node | null;
      if (t && inside(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    // Capture phase: fire before a target's own handler can stopPropagation
    // (Settings sheet) and before default focus moves settle.
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('touchstart', onPointer, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('touchstart', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Focus-restore on the open→closed transition.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const trigger = triggerRef.current;
      if (restoreFocus && trigger) {
        const active = document.activeElement as HTMLElement | null;
        const focusStillInMenu = refsRef.current.some((r) => !!(active && r.current?.contains(active)));
        // Only reclaim focus if the close itself is what orphaned it (focus was
        // still in the menu, or on <body>/null). If the user moved focus out, honour it.
        if (!active || active === document.body || focusStillInMenu) {
          trigger.focus();
        }
      }
      triggerRef.current = null;
    }
    wasOpen.current = open;
  }, [open, restoreFocus]);
}
