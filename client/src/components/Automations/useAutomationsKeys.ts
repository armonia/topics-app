/**
 * The view's keyboard, as on the hub's page, only while the focus is inside
 * the view (never while you type in a field, and never with a modifier):
 *
 * - «/» brings the focus to the search; Esc in the search empties it;
 * - j/k or the arrows move between the rows of the lists;
 * - Esc closes the open automation (the detail gives the focus back to its row).
 *
 * The vote letters (v c n s m) belong to the detail, where the buttons are.
 */
import { useEffect, type RefObject } from 'react';

interface Keys {
  open: boolean;
  close(): void;
  search: RefObject<HTMLInputElement | null>;
  clearSearch(): void;
}

const ROW = '[data-testid="automation-row"], [data-testid="automations-decide-row"] > button';

function typing(t: HTMLElement | null): boolean {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function useAutomationsKeys(root: RefObject<HTMLElement | null>, keys: Keys): void {
  const { open, close, search, clearSearch } = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const box = root.current;
      const t = e.target as HTMLElement | null;
      if (!box || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // Esc with the focus on the page body still closes the open automation; every other key needs the focus inside the view.
      const inside = !!t && box.contains(t);
      if (!inside && !(e.key === 'Escape' && (!t || t === document.body))) return;
      if (e.key === 'Escape') {
        if (t === search.current) { clearSearch(); search.current?.blur(); return; }
        if (typing(t) || !open) return;
        close();
        return;
      }
      if (typing(t)) return;
      if (e.key === '/') {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      const down = e.key === 'j' || e.key === 'ArrowDown';
      const up = e.key === 'k' || e.key === 'ArrowUp';
      if ((!down && !up) || !t?.matches(ROW)) return;
      const rows = Array.from(box.querySelectorAll<HTMLElement>(ROW));
      const i = rows.indexOf(t);
      const next = rows[i + (down ? 1 : -1)];
      e.preventDefault();
      next?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [root, open, close, search, clearSearch]);
}
