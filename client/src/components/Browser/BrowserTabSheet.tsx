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
  const close = useCallback(() => setDraft(null), []);
  const doorPressed = useCallback(() => {
    setDraft(null);
    setSwallowNextRequest(true);
  }, []);

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
            paneId={paneId}
            chrome={chrome}
            draft={draft}
            onDraftChange={setDraft}
            wantsCaret={wantsCaret}
            downloadsOpen={downloadsOpen}
            anchorRef={anchorRef}
            onClose={close}
            onDoorPressed={doorPressed}
          />
        </Suspense>
      )}
    </>
  );
}
