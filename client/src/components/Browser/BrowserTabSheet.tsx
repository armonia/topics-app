/**
 * THE TAB SHEET: ONE SURFACE, AND THERE IS NO SECOND ONE.
 *
 * A browser pane used to spread its chrome over three places, and each of them
 * was a place you had to already know about:
 *
 *   - `BrowserToolbar`, a 40px row above the page that came back whenever the
 *     console opened or a download started, i.e. exactly when you were looking
 *     at something else;
 *   - the three-dots MENU on the tab, which held zoom, device, session and
 *     forget-site behind a glyph that is invisible until you hover it;
 *   - the address DROPDOWN, a fourth surface that existed only to type a URL.
 *
 * All three are one sheet now. A click on the tab you are already in, a click
 * on the three dots, or Cmd+L opens ONE panel that hangs from the tab and holds
 * everything the pane can do, in the order you reach for it: where you are,
 * how to move, where you have been, and then the tools.
 *
 * THIS FILE DECIDES WHEN; `BrowserTabSheetBody` DRAWS. The tab strip is in the
 * eager entry chunk, and the body (console, downloads, suggestions, commands)
 * is not needed before somebody reaches for a browser tab, so it is loaded
 * lazily (`browserTabSheetLazy.ts`) and warmed by the tab on pointer-enter.
 * What stays here is what has to be listening from the first render: the
 * request counters, the draft, and the freeze of the page.
 *
 * The explicit `freeze()` on open is the other half of the occlusion watcher
 * (`lib/shell/browserOcclusion`): the watcher only knows once the panel has
 * been measured, while the sheet knows it is covering the page from the first
 * frame - even while its body is still arriving.
 *
 * The rules that CLOSE it are here for the same reason. Until 2026-09-14 the
 * Esc and click-outside listeners lived in the body, so a sheet opened on a
 * cold chunk was open and deaf: a blank pane asks for its sheet with no pointer
 * near the tab (nothing has warmed it), and the Esc or the click of that window
 * went nowhere; the sheet then came up over whatever came next and took the
 * next Esc as well. Measured on the setup of LAYOUT-40 (`pane-zoom.spec.ts`):
 * the sheet surfaced under a zoom, and one Esc closed it instead of the zoom.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { displayUrl } from '../../lib/browserNavUrl';
import { BrowserTabSheetBody } from './browserTabSheetLazy';

export function BrowserTabSheet({ paneId, label }: { paneId: string; label: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const request = chrome?.addressEditRequest ?? 0;
  const downloadsRequest = chrome?.downloadsOpenRequest ?? 0;

  // A SECOND CLICK ON A DOOR CLOSES INSTEAD OF REOPENING.
  //
  // Clicking the tab's label or its dots while the sheet is open is a
  // pointerdown outside the panel, which closes it, followed by a click that
  // asks for the sheet again: it came straight back, re-seeded, and on the
  // native pane that is a thaw and a freeze with a fresh screenshot in between.
  // So the body flags the press on a door, and the request that click produces
  // is swallowed. The flag only lives until the NEXT pointerdown or keydown:
  // a press on a door that produced no request (a drag, a click on a tab that
  // was not the active one) must not eat a later Cmd+L.
  const [swallowNextRequest, setSwallowNextRequest] = useState(false);
  useEffect(() => {
    if (!swallowNextRequest || typeof document === 'undefined') return;
    const disarm = () => setSwallowNextRequest(false);
    document.addEventListener('pointerdown', disarm, true);
    document.addEventListener('keydown', disarm, true);
    return () => {
      document.removeEventListener('pointerdown', disarm, true);
      document.removeEventListener('keydown', disarm, true);
    };
  }, [swallowNextRequest]);

  // Adjusted DURING the render, the way React wants a state to react to a prop:
  // a request the tab has not acted on yet opens the sheet once.
  //
  // THE DRAFT IS SEEDED WITH THE DOCUMENT, NOT WITH THE TRANSPORT. A local file
  // travels as `…/api/media?path=%2F…`, so seeding the raw url put an address
  // nobody can read, edit or recognise under the caret. `displayUrl` gives back
  // the document, and `toNavigableUrl` on submit turns it into the transport
  // again: the same pair, both ways.
  const [seen, setSeen] = useState(request);
  const [draft, setDraft] = useState<string | null>(null);
  // Which door was used, decided at the instant of opening and not derived from
  // comparing the two counters: they grow independently, so "downloads is the
  // bigger one" is false after three ⌘L and one click on the cue.
  const [wantsCaret, setWantsCaret] = useState(true);
  if (request !== seen) {
    setSeen(request);
    if (request > seen) {
      if (swallowNextRequest) {
        setSwallowNextRequest(false);
      } else {
        setDraft(displayUrl(chrome?.url ?? ''));
        setWantsCaret(true);
      }
    }
  }

  // THE SECOND DOOR OPENS THE SAME PANEL AND ASKS FOR SOMETHING ELSE: the
  // downloads cue wants its list, not the caret. Opened from there the address
  // field is NOT focused and NOT selected, so looking at a file never leaves a
  // selection to undo on a page you were only reading. `downloadsOpen` is the
  // counter `DownloadsMenu` watches (`requestOpen`), so the section is already
  // down when the panel appears.
  const [seenDl, setSeenDl] = useState(downloadsRequest);
  const [downloadsOpen, setDownloadsOpen] = useState(0);
  if (downloadsRequest !== seenDl) {
    setSeenDl(downloadsRequest);
    if (downloadsRequest > seenDl) {
      setDownloadsOpen((n) => n + 1);
      // The field carries the address either way (it is the top of the panel,
      // and an empty one would read as "no page").
      if (draft === null) setDraft(displayUrl(chrome?.url ?? ''));
      setWantsCaret(false);
    }
  }
  const open = draft !== null;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setDraft(null), []);
  /** The mark the popovers opened FROM the sheet carry. */
  const owner = `browser-tab-sheet:${paneId}`;

  // A CLICK OUTSIDE CLOSES, AND THE CLICK STILL HAPPENS.
  //
  // Not `useDismissable`: that contract EATS the click that follows an outside
  // pointerdown ("closing is all that click does"), which is right for a menu
  // and wrong here, because a blank pane opens this sheet BY ITSELF - so the
  // very next click anywhere (the X of a tab, a toggle in a drawer) would close
  // the sheet and do nothing else. Measured on CI run 34050396220 (2026-09-06)
  // when the address dropdown had that contract. Listening on `pointerdown`
  // without swallowing keeps both: the sheet goes, the click lands.
  //
  // ESC CLOSES FROM ANYWHERE, not only from the address field: the downloads
  // door never puts the caret there, and a click on any button of the sheet
  // moves the focus off it (to BODY, on WebKit).
  //
  // In the BUBBLE phase, and the phase is what gives a popover of the sheet the
  // first word. `useDismissable` listens in CAPTURE on this same document and
  // stops propagation there, so the first Esc closes the downloads list or the
  // console and never reaches this listener; the second one closes the sheet.
  // `defaultPrevented` does NOT carry that precedence (`useDismissable` does
  // not call `preventDefault`): measured, a capture listener here closed the
  // list and the sheet together on the first Esc. The check stays for the
  // handlers that did consume the key, the find bar's among them.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element) {
        // A popover the sheet itself opened is portalled OUT of it: a click in
        // there is a click inside, and closing the sheet under it would take
        // its own anchor away. ONLY those: any other glass surface open at the
        // same time (the sheet of another pane, say) is outside like the rest.
        if (target.closest('[data-popover-owner]')?.getAttribute('data-popover-owner') === owner) return;
        // The tab's own doors (its label, its dots) TOGGLE: this press closes,
        // and the click that follows is told not to reopen.
        const door = target.closest('[data-sheet-door]');
        if (door && anchorRef.current?.closest('[data-pane-id]')?.contains(door)) {
          setDraft(null);
          setSwallowNextRequest(true);
          return;
        }
      }
      setDraft(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setDraft(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, owner]);

  // THE PAGE IS A STILL WHILE THE SHEET COVERS IT, and it says so itself rather
  // than waiting to be measured. `thaw` on close AND on unmount: a pane whose
  // tab is dragged to another group while its sheet is open would otherwise
  // leave the page parked behind a picture with nothing left to bring it back.
  const freeze = chrome?.commands.freeze;
  const thaw = chrome?.commands.thaw;
  useEffect(() => {
    if (!open) return;
    freeze?.();
    return () => { thaw?.(); };
  }, [open, freeze, thaw]);

  return (
    <>
      <span ref={anchorRef}>{label}</span>
      {open && chrome && (
        // `fallback={null}`: a cold body is one chunk away, and the tab has
        // usually warmed it on pointer-enter before the click that opened it.
        <Suspense fallback={null}>
          <BrowserTabSheetBody
            chrome={chrome}
            draft={draft}
            onDraftChange={setDraft}
            wantsCaret={wantsCaret}
            downloadsOpen={downloadsOpen}
            anchorRef={anchorRef}
            panelRef={panelRef}
            owner={owner}
            onClose={close}
          />
        </Suspense>
      )}
    </>
  );
}
