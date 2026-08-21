/**
 * The drawer's accordion, in one place.
 *
 * WHY IT EXISTS. The pattern was written by hand FIVE times in `TaskDetail.tsx`
 * — five `useState` reading `localStorage`, five toggles writing it back, five
 * copies of the same header button — and the sixth section never got written at
 * all: "File consegnati" shipped as a bare label with no handle, so a card with
 * six attachments carried a list you could not close. That is what a
 * copy-pasted pattern costs: not the duplication, the section somebody forgets.
 *
 * OPEN BY DEFAULT, and remembered per section. A drawer that opens with
 * everything shut hides the very thing it was opened for; a drawer that forgets
 * what you closed makes you close it again on every card.
 *
 * TWO PIECES, NOT ONE COMPONENT. Some sections need to know whether they are
 * open in order to lay themselves out (the workspace takes `flex-1` when open
 * and `shrink-0` when shut, and its scroll cap changes with it), so the state
 * lives in a hook the caller owns and the header is a separate component. One
 * all-in-one `<Section>` would have forced those callers back to a hand-rolled
 * copy, which is exactly the shape we are removing.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';

/** Storage key for a section. One writer, so a rename cannot half-apply. */
export function sectionKey(id: string): string {
  return `board:task${id}Open`;
}

/**
 * Reading is deliberately "anything but the string '0' means open".
 *
 * Private mode throws on `localStorage`, a cleared profile returns null, and an
 * older build may have written something else entirely. Every one of those is a
 * card that should open normally, not a section stuck shut for a reason nobody
 * can see.
 */
export function readSectionOpen(id: string, storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    return store?.getItem(sectionKey(id)) !== '0';
  } catch {
    return true;
  }
}

export function writeSectionOpen(id: string, open: boolean, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    store?.setItem(sectionKey(id), open ? '1' : '0');
  } catch { /* private mode: the section still works, it just forgets */ }
}

/**
 * Open state for one section, persisted under its own key.
 *
 * The third element is not a convenience: adding a subtask from the card menu
 * has to OPEN the section, not flip it, or the gesture closes the very list it
 * just added a row to when the section happened to be open already.
 */
export function useSectionOpen(id: string): [boolean, () => void, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readSectionOpen(id));
  const set = useCallback((next: boolean) => {
    writeSectionOpen(id, next);
    setOpen(next);
  }, [id]);
  const toggle = useCallback(() => {
    setOpen((was) => {
      const now = !was;
      writeSectionOpen(id, now);
      return now;
    });
  }, [id]);
  return [open, toggle, set];
}

/**
 * The handle of a section.
 *
 * `label` is the accessible name and stays exact: the specs and anyone
 * navigating by voice ask for "Descrizione", not "Descrizione · 4/7". Anything
 * that counts goes in `suffix`, rendered outside the name.
 */
export function SectionHeader({
  open, onToggle, label, suffix, testId, chevron = true, grow = false, disabled = false, padded = false,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  suffix?: string;
  testId?: string;
  /** A section with nothing inside shows its title without a handle. */
  chevron?: boolean;
  /** The header shares its row with an action (the preview's "recapture"),
   *  so it takes the leftover width instead of the whole row. */
  grow?: boolean;
  /** Nothing to open: the title stays, the handle stops responding. Used by the
   *  workspace, which keeps its row (and the door to open a pane) with no panes. */
  disabled?: boolean;
  /** The workspace header IS the chrome above the tab bar, so it carries its own
   *  vertical padding instead of inheriting a section's. */
  padded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={testId}
      data-open={open ? '1' : '0'}
      disabled={disabled}
      className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading ${grow ? 'min-w-0 flex-1' : 'w-full'} ${padded ? 'py-2 text-left' : ''} disabled:hover:text-app-text-muted`}
    >
      {chevron && (open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />)}
      <span className="truncate">{label}</span>
      {suffix ? <span className="font-normal normal-case tracking-normal text-app-text-faint">{suffix}</span> : null}
    </button>
  );
}
