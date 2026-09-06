/**
 * THE ADDRESS OPENS UNDER THE TAB, IT DOES NOT REPLACE IT.
 *
 * The tab writes the page title and keeps writing it (see `browserTabLabel`);
 * this is the half that lets you type an address without a permanent row under
 * the pane. The pane asks for it by bumping `addressEditRequest` in its
 * published chrome (Cmd+L, the tab menu's "edit address", the click on the tab
 * you are already in, a blank pane that wants somewhere to go); the tab answers
 * by opening a DROPDOWN anchored to its own bottom edge. Enter goes there,
 * Escape or a click elsewhere closes it.
 *
 * WHY A DROPDOWN AND NOT THE LABEL ITSELF, which is what this component did
 * until now: swapping the label for an input made the tab stop naming its page
 * the moment you touched it, and on a blank pane (which opens the editor by
 * itself) the tab had no text at all. A panel under the tab leaves the label
 * alone and has room for the WHOLE address instead of the width of a tab.
 *
 * `POPOVER_SURFACE` is not a style choice: it is the class `OVERLAY_SELECTOR`
 * matches (`lib/shell/browserOcclusion`), and that match is what freezes the
 * native webview underneath so the panel is visible at all on the Tauri desktop
 * app. A hand-rolled surface would paint UNDER the page.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { displayUrl, toNavigableUrl } from '../../lib/browserNavUrl';
import { computeMenuPosition } from '../../lib/popoverPosition';
import { POPOVER_SURFACE, POPOVER_MARGIN, Z_POPOVER } from '../../lib/popoverStyles';
import { useDismissable } from '../../hooks/useDismissable';

/** The panel is never narrower than the tab, and never wider than this: past
 *  480px an address stops being read and starts being scanned. */
const MAX_WIDTH = 480;
/** A tab can be very short (a pinned one is barely an icon); the panel still
 *  has to hold an address. */
const MIN_WIDTH = 260;

export function BrowserTabAddress({ paneId, label }: { paneId: string; label: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const request = chrome?.addressEditRequest ?? 0;
  // Adjusted during the render, the way React wants a state to react to a
  // prop: a request the tab has not acted on yet opens the editor once.
  const [seen, setSeen] = useState(request);
  const [draft, setDraft] = useState<string | null>(null);
  if (request !== seen) {
    setSeen(request);
    // THE EDITOR IS SEEDED WITH THE DOCUMENT, NOT WITH THE TRANSPORT. A local
    // file travels as `…/api/media?path=%2FUsers%2F…`, so seeding the raw url
    // put `tauri://localhost/api/media?path=%2FUsers%2F…` under the caret: an
    // address nobody can read, edit or recognise. `displayUrl` gives back the
    // document (`file:///Users/…/b.pdf`), and `toNavigableUrl` on submit turns
    // it into the transport again - the two are the same pair, both ways.
    if (request > seen) setDraft(displayUrl(chrome?.url ?? ''));
  }
  const open = draft !== null;
  const hasDom = typeof document !== 'undefined';

  const labelRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const close = useCallback(() => setDraft(null), []);
  // The shared dismissal contract (capture-phase outside pointer + Escape +
  // focus restore) instead of a hand-rolled document listener: it is also what
  // makes this panel obey the one-popover-at-a-time registry. Gated on `hasDom`
  // because the unit runtime has no document (see `test/reactHarness`), and the
  // hook returns before touching one when `open` is false.
  useDismissable({ open: open && hasDom, onClose: close, refs: [panelRef] });

  // THE PANEL IS MEASURED, NOT GUESSED, and placed by the same function as the
  // tab context menu a few hundred lines away in `PaneTabBar`: it clamps to the
  // viewport and flips above the tab when there is no room below.
  useLayoutEffect(() => {
    if (!open || !hasDom) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to a constant on close: converges at once and cannot loop
      setPos(null);
      return;
    }
    // The anchor is the TAB, not the label span inside it: the panel lines up
    // with the tab's bottom edge and its left edge, the way a browser's own
    // address dropdown does.
    const anchorEl = labelRef.current?.closest('[data-pane-id]') ?? labelRef.current;
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const width = Math.min(MAX_WIDTH, Math.max(r.width, MIN_WIDTH));
    const height = panelRef.current?.getBoundingClientRect().height ?? 0;
    const next = computeMenuPosition(
      { top: r.top, right: r.right, bottom: r.bottom, left: r.left },
      { width, height },
      { margin: POPOVER_MARGIN, minHeight: height },
    );
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.width === width
        ? prev
        : { top: next.top, left: next.left, width },
    );
  }, [open, hasDom]);

  useEffect(() => {
    if (!open) return;
    // After the paint that mounts the input: focus and select, so a new
    // address is one keystroke away.
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const go = () => {
    const typed = (draft ?? '').trim();
    setDraft(null);
    if (typed) chrome?.commands.navigate?.(toNavigableUrl(typed));
  };

  const panel = open ? (
    <div
      ref={panelRef}
      data-testid="browser-address-dropdown"
      role="dialog"
      aria-label="Address"
      className={`fixed ${POPOVER_SURFACE} px-2`}
      style={{
        // Until the measure lands the panel is off-screen and invisible:
        // rendered (it has to be, to be measured) but never shown at the wrong
        // place, so it does not jump from one corner to another.
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: pos?.width,
        minWidth: MIN_WIDTH,
        maxWidth: MAX_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: Z_POPOVER,
      }}
      // The tab bar drags and selects on these: the panel keeps them.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        data-testid="browser-tab-address-input"
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') go();
          else if (e.key === 'Escape') close();
        }}
        onBlur={close}
        spellCheck={false}
        autoComplete="off"
        aria-label="address"
        className="w-full min-w-0 bg-transparent outline-none text-app-text text-[12px] py-1 p-0 m-0 border-0"
      />
    </div>
  ) : null;

  return (
    <>
      <span ref={labelRef}>{label}</span>
      {/* The portal is a PLACEMENT concern only: with no document (the unit
          runtime has no DOM) the same panel renders in place. */}
      {panel && (hasDom ? createPortal(panel, document.body) : panel)}
    </>
  );
}
