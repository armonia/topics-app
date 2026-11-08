/**
 * THE TAB SHEET: ONE COMMAND SURFACE PER TAB, AND IT IS THE TAB ITSELF
 * (TABSHEET-01).
 *
 * A tab used to have two surfaces that did not talk to each other: a click on a
 * browser tab opened its sheet (address, navigation, tools), a right click on
 * any tab opened a dropdown (pin, rename, split, close). They had one command
 * twice under two names and each missed half of the other. Now every door of a
 * tab (a click on the active browser tab, its dots, Cmd+L, the downloads cue, a
 * right click, a long press, Shift+F10) opens THIS sheet, which grows out of
 * the tab: same surface, no edge between the two (`data-sheet-open` on the
 * tab, see index.css).
 *
 * THIS FILE DECIDES WHEN; `TabSheetBody` DRAWS. The tab strip is in the eager
 * entry chunk and the body is not needed before somebody reaches for a tab, so
 * the body is loaded lazily (`tabSheetLazy.ts`) and warmed on pointer-enter.
 * What stays here is what has to listen from the first render: which sheet is
 * open (`state/tabSheet`), the browser pane's own requests, the rules that
 * close it and the freeze of the page. A sheet opened on a cold chunk is
 * therefore never deaf: until 2026-09-14 the Esc and click-outside listeners
 * lived in the body, and a sheet opened before its body arrived took the next
 * Esc meant for something else.
 *
 * It lives in the tab's React subtree and dies with the tab (TOPIC-BROWSER-02);
 * the body is portalled to <body> because the strip has a transformed ancestor,
 * which would become the containing block of a `position: fixed` panel.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { closeTabSheet, openTabSheet, swallowNextOpen, useOpenTabSheet } from '../../state/tabSheet';
import { registerOpenPopover } from '../../lib/popoverRegistry';
import { displayUrl } from '../../lib/browserNavUrl';
import { TabSheetBody } from './tabSheetLazy';
import type { TabSheetTarget } from './tabSheetTypes';

/** The attribute a surface puts on the element the sheet grows out of. */
export const TAB_SHEET_ANCHOR_ATTR = 'data-tab-sheet-anchor';

export interface TabSheetProps {
  /** The store key: a pane id, or `title:<paneId>` for the phone title. */
  sheetKey: string;
  target: TabSheetTarget;
  /** Listen to the browser pane's own requests (Cmd+L, the dots, a blank
   *  pane). Off where another surface of the same pane already listens. */
  listenToPane?: boolean;
}

export function TabSheet({ sheetKey, target, listenToPane = true }: TabSheetProps) {
  const open = useOpenTabSheet(sheetKey);
  const isBrowser = target.pane.type === 'browser';
  const chrome = useBrowserPaneChrome(isBrowser ? target.pane.id : undefined);
  const markerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const owner = `tab-sheet:${sheetKey}`;
  const anchor = useCallback(
    () => markerRef.current?.closest<HTMLElement>(`[${TAB_SHEET_ANCHOR_ATTR}]`) ?? null,
    [],
  );

  // THE BROWSER PANE ASKS FOR ITS SHEET through two counters in its chrome:
  // the caret (Cmd+L, a click on the active tab, the dots, a blank pane) and
  // the downloads list (the cue). Only a request newer than the last one seen
  // opens; a counter that went back (the pane remounted) is simply re-read.
  const addressRequest = listenToPane ? (chrome?.addressEditRequest ?? 0) : 0;
  const downloadsRequest = listenToPane ? (chrome?.downloadsOpenRequest ?? 0) : 0;
  const seenAddress = useRef(addressRequest);
  const seenDownloads = useRef(downloadsRequest);
  useEffect(() => {
    if (addressRequest > seenAddress.current) openTabSheet(sheetKey, 'address');
    seenAddress.current = addressRequest;
  }, [addressRequest, sheetKey]);
  useEffect(() => {
    if (downloadsRequest > seenDownloads.current) openTabSheet(sheetKey, 'downloads');
    seenDownloads.current = downloadsRequest;
  }, [downloadsRequest, sheetKey]);

  // THE ADDRESS IS THE DOCUMENT, NOT THE TRANSPORT: a local file travels as
  // `/api/media?path=…`, and `displayUrl` gives back the address a person can
  // read and edit. Until the person types, the field FOLLOWS the page (a sheet
  // opened while the pane is still restoring its address must not freeze on
  // an empty field); from the first keystroke it is theirs, until the sheet
  // closes.
  const [typed, setTyped] = useState<string | null>(null);
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const seq = open?.seq ?? null;
  if (seq !== seenSeq) {
    setSeenSeq(seq);
    setTyped(null);
  }
  const draft = typed ?? displayUrl(chrome?.url ?? '');

  // A CLICK OUTSIDE CLOSES, AND THE CLICK STILL HAPPENS. Not `useDismissable`,
  // whose contract eats the click that follows an outside press: a blank pane
  // opens this sheet by itself, so the next click anywhere would only close it
  // (CI run 34050396220, 2026-09-06). Esc closes from anywhere, in the BUBBLE
  // phase: a level or a popover of the sheet listens in capture and stops the
  // key there, so the first Esc closes the level and the second the sheet.
  const closedByOutsidePress = useRef(false);
  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    closedByOutsidePress.current = false;
    const onDown = (e: PointerEvent) => {
      const hit = e.target as Node | null;
      if (!hit) return;
      if (panelRef.current?.contains(hit)) return;
      if (hit instanceof Element) {
        // A level or a popover the sheet opened is portalled OUT of it, and is
        // still inside it. Only those: another surface's popover is outside.
        if (hit.closest('[data-popover-owner]')?.getAttribute('data-popover-owner') === owner) return;
        // THE TAB'S OWN DOORS TOGGLE: a press on its label, its dots, or a
        // right click on it closes the sheet, and the request the same gesture
        // makes a moment later (the click, the contextmenu) is dropped.
        const tab = anchor();
        if (tab?.contains(hit) && (hit.closest('[data-sheet-door]') || e.button === 2 || e.ctrlKey)) {
          closeTabSheet(sheetKey);
          swallowNextOpen(sheetKey, document, e);
          return;
        }
      }
      closedByOutsidePress.current = true;
      closeTabSheet(sheetKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // The Esc is spent here: a surface under the sheet that closes on Esc
      // from `window` (a task's drawer) reads `defaultPrevented` and stays.
      // One press, one thing closed (TABSHEET-02).
      e.preventDefault();
      closeTabSheet(sheetKey);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, owner, sheetKey, anchor]);

  // ONE FLOATING SURFACE AT A TIME: opening the sheet closes any other popover
  // (a menu opened from the keyboard would otherwise stay under it), and a
  // modal that clears every popover clears the sheet too. Its levels are
  // sub-surfaces of it, so they do not evict it.
  useEffect(() => {
    if (!isOpen) return;
    return registerOpenPopover({
      close: () => closeTabSheet(sheetKey),
      trigger: anchor,
      nodes: () => [anchor(), panelRef.current],
      exclusive: true,
    });
  }, [isOpen, sheetKey, anchor]);

  // THE TAB AND THE SHEET ARE ONE SURFACE while it is open: the tab says so on
  // itself, and index.css paints it with the sheet's own fill.
  useEffect(() => {
    if (!isOpen) return;
    const tab = anchor();
    tab?.setAttribute('data-sheet-open', '');
    return () => { tab?.removeAttribute('data-sheet-open'); };
  }, [isOpen, anchor]);

  // THE FOCUS GOES BACK TO THE TAB on Esc, on an action and on the door that
  // closes, never after a press somewhere else: that press put the focus where
  // it wanted.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !isOpen && !closedByOutsidePress.current) {
      const active = document.activeElement;
      if (!active || active === document.body) anchor()?.focus({ preventScroll: true });
    }
    wasOpen.current = isOpen;
  }, [isOpen, anchor]);

  // THE PAGE IS A STILL WHILE THE SHEET COVERS IT, said by the sheet from the
  // first frame instead of waiting to be measured by the occlusion watcher.
  // `thaw` on close AND on unmount: a tab dragged away with its sheet open
  // would otherwise leave the page parked behind a picture.
  const freeze = chrome?.commands.freeze;
  const thaw = chrome?.commands.thaw;
  useEffect(() => {
    if (!isOpen) return;
    freeze?.();
    return () => { thaw?.(); };
  }, [isOpen, freeze, thaw]);

  // Closing on unmount: a tab that goes away with its sheet open must not
  // leave the store pointing at a sheet nobody draws.
  useEffect(() => () => closeTabSheet(sheetKey), [sheetKey]);

  return (
    <>
      <span ref={markerRef} hidden />
      {open && (
        // `fallback={null}`: the tab usually warmed the chunk on pointer-enter.
        <Suspense fallback={null}>
          <TabSheetBody
            door={open.door}
            seq={open.seq}
            anchor={anchor}
            panelRef={panelRef}
            owner={owner}
            target={target}
            chrome={chrome}
            draft={draft}
            onDraftChange={setTyped}
            onClose={() => closeTabSheet(sheetKey)}
          />
        </Suspense>
      )}
    </>
  );
}
