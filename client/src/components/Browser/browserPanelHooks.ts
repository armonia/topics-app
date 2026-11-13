import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFindState, nextIndex, registerFinder, reportFindResult, type PaneFinder } from '../../state/findRegistry';
import { createDomFinder } from '../../lib/domFind';
import { focusBrowserPane } from '../../lib/shell/tauri';
import { useBrowserSpawner } from '../../state/browserSpawner';
import { signalsActions } from '../../state/signals';
import type { Topic } from '../../types';

/**
 * How long a pane that KNOWS its URL (a restored tab, a tab opened on a link)
 * waits for it before offering the New Tab page. The seed of a restored pane
 * leaves after 400 ms (`useSeedPaneUrl`); past this grace a URL that was never
 * going to be applied (a private address the seed refuses) gets the New Tab
 * page, as before, just not before the navigation had a chance.
 */
const NEW_TAB_GRACE_MS = 700;

/**
 * True while the pane has a destination it has not reached yet: a
 * `navigateUrl` not consumed, or a known URL within the grace. The New Tab page
 * waits while this is true (fluidity audit panes:F16).
 */
export function useUrlPending(knownUrl: string | undefined, navigateUrl: string | undefined): boolean {
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), NEW_TAB_GRACE_MS);
    return () => clearTimeout(t);
  }, []);
  return !!navigateUrl || (!!knownUrl && !graceOver);
}

/** Report a browser pane's busy state (page loading or an agent driving it)
 *  into the unified signals store, so its tab spinner + the project rollup
 *  react. Shared by the web (useRemoteBrowser) and native (useTauriBrowser)
 *  render paths — both expose loading/agentActive. */
export function useReportBrowserActivity(contextId: string, busy: boolean) {
  const paneId = `browser:${contextId}`;
  useEffect(() => {
    signalsActions.setBrowserBusy(paneId, busy);
  }, [paneId, busy]);
  useEffect(() => () => signalsActions.setBrowserBusy(paneId, false), [paneId]);
}

/**
 * Shared spawner-aware back-button wiring. Both panel inner-components
 * (streaming + native) call this to derive the sheet's
 * `backToSpawner` command from the registry, layout focus
 * callback, and topics map. Returns `undefined` when no back button should
 * render — either because no spawner was recorded, the layout did not pass
 * a focus callback, or the spawner topic no longer exists.
 */
export function useBackToSpawner(
  contextId: string,
  onFocusPanel?: (paneId: string) => void,
  topics?: Record<string, Topic>,
): { onBackToSpawner: () => void; spawnerLabel?: string } | undefined {
  const spawnerTopicId = useBrowserSpawner(contextId);
  return useMemo(() => {
    if (!spawnerTopicId || !onFocusPanel) return undefined;
    // Only surface the button when the topic is known to this renderer
    // (avoids a "back to ???" with a dead target if the spawner was
    // archived or closed). Using topics?.[id] is null-safe.
    const topic = topics?.[spawnerTopicId];
    if (!topic) return undefined;
    return {
      onBackToSpawner: () => onFocusPanel(spawnerTopicId),
      spawnerLabel: topic.name,
    };
  }, [spawnerTopicId, onFocusPanel, topics]);
}

/**
 * The finder of a native browser pane (BROWSER-FIND-01/02): `window.find` in
 * the page for the selection, the innerText count for the total, and the
 * index kept here (`stepMatchIndex`, the same wrap as `window.find`). Esc
 * gives the keyboard back to the page when the bar was opened from inside it
 * (FIND-03, `browser_focus_pane`).
 */
export function useNativeBrowserFinder(
  paneId: string,
  contextId: string,
  browser: { findInPage: (t: string, o?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }) => Promise<void>; stopFind: () => Promise<void>; countMatches?: (t: string, o?: { matchCase?: boolean }) => Promise<number> },
): void {
  const browserRef = useRef(browser);
  useEffect(() => { browserRef.current = browser; });
  useEffect(() => {
    let query = '';
    let matchCase = false;
    const count = async () => (await browserRef.current.countMatches?.(query, { matchCase })) ?? 0;
    const finder: PaneFinder = {
      // The count walks the whole page text through an IPC round trip.
      debounceMs: 150,
      async search(q, o) {
        query = q;
        matchCase = o.matchCase;
        return count();
      },
      async step(forward) {
        await browserRef.current.findInPage(query, { forward, findNext: true, matchCase });
        // The total can still be on its way (debounce): asking here is what
        // makes «1 of 12» true at the first Enter.
        const total = getFindState(paneId).total ?? await count();
        return { index: nextIndex(paneId, total, forward), total };
      },
      clear() { void browserRef.current.stopFind(); },
      restoreFocus({ openedFromPage }) { if (openedFromPage) focusBrowserPane(contextId); },
    };
    return registerFinder(paneId, finder);
  }, [paneId, contextId]);
}

/**
 * The finder of the shared browser (BROWSER-FIND-04). In `dom` mode the page
 * is an rrweb mirror rebuilt in a same-origin iframe of THIS client, so the
 * text is already here: `domFind` walks it, highlights in the iframe's own
 * `CSS.highlights` and recounts on rrweb mutations. In `video` mode the page
 * is pixels: the bar opens with the field disabled and says so. In neither
 * mode does ⌘F fall back to the project search.
 */
export function useSharedBrowserFinder(paneId: string, renderMode: 'dom' | 'video'): (read: (() => Document | null) | null) => void {
  const modeRef = useRef(renderMode);
  useEffect(() => { modeRef.current = renderMode; });
  const readDocRef = useRef<(() => Document | null) | null>(null);
  useEffect(() => {
    const dom = createDomFinder({
      root: () => readDocRef.current?.()?.body ?? null,
      observeMutations: true,
      injectStyle: true,
      onRecount: (r) => reportFindResult(paneId, r),
    });
    const finder: PaneFinder = {
      get unavailableKey() { return modeRef.current === 'video' ? 'find.unavailable.video' : undefined; },
      debounceMs: dom.debounceMs,
      search: (q, o) => (modeRef.current === 'video' ? 0 : dom.search(q, o)),
      step: (f) => (modeRef.current === 'video' ? { index: 0, total: 0 } : dom.step(f)),
      clear: () => dom.clear(),
    };
    const off = registerFinder(paneId, finder);
    return () => { off(); dom.dispose(); };
  }, [paneId]);
  return useCallback((read: (() => Document | null) | null) => { readDocRef.current = read; }, []);
}
