/**
 * Pause and resume of a HEAVY native browser pane (`useTauriBrowser`).
 *
 * PAUSE = the page stays exactly where it is (same WKWebView/WebView2 instance,
 * same document, scroll, form state and login) and the native view is HIDDEN
 * behind a still of its current page. Hiding is what WebKit and WebView2 turn
 * into `visibilityState: hidden`: rAF and the WebGL loop stop, timers throttle.
 * No reload, no close, no navigation on either path.
 *
 * THE ORDER THAT MATTERS.
 *  1. The still is taken while the view is on screen (a hidden view snapshots
 *     blank), drawn at 1x, and painted under the live view.
 *  2. Only then does `pauseState` become `paused`, and the owner's visibility
 *     effect hides the view in a LATER commit.
 *  3. Resume adopts the still as the overlay freeze (`frozenRef`, the view parked
 *     off-screen) before showing the view, then hands the decision to the
 *     existing occlusion path: nothing over the slot -> `thaw()`; an overlay over
 *     it -> the still stays and `thaw()` runs when the overlay closes. One path,
 *     whether or not an overlay is open at that moment.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { isTauri } from '../lib/shell';
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from '../lib/settings';
import { PAUSE_DWELL_MS, paneLive } from '../lib/shell/nativePaneLive';
import { toPausedStill } from '../lib/shell/pausedStill';
import { tauriInvoke } from '../lib/shell/tauri';
import { subscribeWindowFocus, windowFocused } from '../lib/shell/windowFocus';
import {
  forgetPane, heavyVerdict, holdSampleFallback, noteSystemMemory, reportPaneContext, subscribeHeavyVerdict,
  type HeavyVerdict, type ShellWebviewRow,
} from '../lib/shell/heavyPanes';

export type PauseState = 'live' | 'pausing' | 'paused';

/** The screenshot waits at most this long; the shell's own timeout is 10 s. */
const STILL_TIMEOUT_MS = 1_500;

/** Stable for `useSyncExternalStore`: a fresh function per render resubscribes. */
const subscribeFocusChange = (cb: () => void): (() => void) => subscribeWindowFocus(() => cb());
const subscribeSettings = (cb: () => void): (() => void) => {
  const onChange = () => { keptCache = null; cb(); };
  window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
};
const readPanePerf = (): Promise<readonly ShellWebviewRow[] | undefined> =>
  tauriInvoke<{ webviews?: ShellWebviewRow[]; system_mem_mb?: number | null }>('perf_metrics').then((m) => {
    noteSystemMemory(m?.system_mem_mb);
    return m?.webviews;
  });
/** An element of the page in full screen. WebKit moves it into a window of its
 *  own, which takes the key state from Topics: without this the video or canvas
 *  on screen would go black at the end of the dwell. */
const FULL_SCREEN_JS =
  "(function(){try{return (document.fullscreenElement||document.webkitFullscreenElement)?'1':''}catch(e){return ''}})()";
/** origin + pathname: the page a heavy verdict is about. */
function urlKeyOf(u: string): string {
  try { const p = new URL(u); return p.origin + p.pathname; } catch { return u; }
}

interface PauseDeps {
  id: string;
  ready: boolean;
  isVisible: boolean;
  /** The focus of this pane on its surface (see `lib/shell/nativePaneLive`). */
  hasFocus: boolean;
  agentActive: boolean;
  url: string;
  loading: boolean;
  parked: boolean;
  pauseStateRef: MutableRefObject<PauseState>;
  openedRef: MutableRefObject<boolean>;
  frozenRef: MutableRefObject<boolean>;
  freezeSeqRef: MutableRefObject<number>;
  frozenImage: string | null;
  setFrozenImage: (url: string | null) => void;
  lastRealSizeRef: MutableRefObject<{ width: number; height: number }>;
  pendingRectRef: MutableRefObject<{ x: number; y: number; width: number; height: number } | null>;
  agentOpsInFlightRef: MutableRefObject<number>;
  agentActiveRef: MutableRefObject<boolean>;
  paneInvoke: (cmd: string, args: Record<string, unknown>) => Promise<boolean>;
  setNativeVisible: (visible: boolean) => Promise<boolean>;
  evaluateOcclusionRef: MutableRefObject<() => void>;
}

export interface NativePanePause {
  heavy: HeavyVerdict | null;
  pauseState: PauseState;
  pausedImage: string | null;
  resume: () => void;
  /** «Mantieni per questa volta»: resume, and do not pause this page again
   *  until it navigates somewhere else or the pane is reopened. */
  keepOnce: () => void;
  /** «Mantieni sempre»: resume, and never pause this site (origin) again. */
  keepAlways: () => void;
}

/** origin of a URL, or '' for one that has none (about:blank, a file). */
function originOf(u: string): string {
  try { const o = new URL(u).origin; return o === 'null' ? '' : o; } catch { return ''; }
}

/** The sites the person chose to keep live. Read from the settings once and
 *  again on every settings change (a choice made on another device arrives
 *  through the settings sync), not on every render of every browser pane. */
let keptCache: readonly string[] | null = null;
function keptSites(): readonly string[] {
  if (keptCache === null) keptCache = loadSettings().keepLiveSites ?? [];
  return keptCache;
}

function revoke(url: string | null): void {
  if (url && url.startsWith('blob:') && typeof URL !== 'undefined') URL.revokeObjectURL(url);
}

export function useNativePanePause(d: PauseDeps): NativePanePause {
  const { id } = d;
  const heavyNow = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeHeavyVerdict(id, cb), [id]),
    () => heavyVerdict(id),
  );
  const winFocus = useSyncExternalStore(subscribeFocusChange, windowFocused);
  // The two «keep» choices are exemptions of the same kind as an agent
  // driving the page: the pane stays live without focus. «Once» is tied to the
  // page (origin + path) it was given on; «always» to the site.
  const [keptOnceKey, setKeptOnceKey] = useState<string | null>(null);
  const pageKey = urlKeyOf(d.url);
  const origin = originOf(d.url);
  const keptAlways = useSyncExternalStore(
    subscribeSettings,
    () => (origin ? keptSites().includes(origin) : false),
  );
  const kept = keptAlways || (keptOnceKey !== null && keptOnceKey === pageKey);
  // Ops in flight and an open inspector are read when the dwell ends, not here:
  // neither is render state.
  const live = paneLive({
    heavy: !!heavyNow, paneFocused: d.hasFocus, windowFocused: winFocus,
    agentActive: d.agentActive, opsInFlight: 0, devtoolsOpen: false, keptLive: kept,
  });
  const [pauseState, setPauseStateValue] = useState<PauseState>('live');
  const [pausedImage, setPausedImage] = useState<string | null>(null);
  const pausedImageRef = useRef<string | null>(null);
  const pauseSeqRef = useRef(0);
  const liveRef = useRef(live);
  const frozenImageRef = useRef(d.frozenImage);
  const depsRef = useRef(d);
  // Declared first, so it runs before every other effect of this hook: the
  // callbacks below read the latest render through these refs.
  useEffect(() => {
    liveRef.current = live;
    frozenImageRef.current = d.frozenImage;
    depsRef.current = d;
  });

  const setPauseState = useCallback((next: PauseState) => {
    depsRef.current.pauseStateRef.current = next;
    setPauseStateValue(next);
  }, []);
  const setStill = useCallback((url: string | null) => {
    pausedImageRef.current = url;
    setPausedImage(url);
  }, []);

  const startPause = useCallback(async () => {
    const x = depsRef.current;
    if (!x.openedRef.current || x.pauseStateRef.current !== 'live') return;
    setPauseState('pausing');
    const seq = ++pauseSeqRef.current;
    // An overlay froze the pane already: that still IS the current page, and
    // the view is parked, where a screenshot would still work but costs a trip.
    let dataUrl = x.frozenRef.current ? frozenImageRef.current : null;
    if (!dataUrl) {
      const shot = await Promise.race([
        tauriInvoke<string>('browser_screenshot', { id: x.id }).catch(() => ''),
        new Promise<string>((r) => setTimeout(() => r(''), STILL_TIMEOUT_MS)),
      ]);
      dataUrl = shot ? `data:image/png;base64,${shot}` : null;
    }
    if (seq !== pauseSeqRef.current) return;
    const slot = x.pendingRectRef.current ?? x.lastRealSizeRef.current;
    const still = dataUrl ? await toPausedStill(dataUrl, slot.width, slot.height) : null;
    if (seq !== pauseSeqRef.current) { revoke(still); return; }
    setStill(still);
    // The same wait `freeze()` takes: one frame for the commit, one for the
    // still on glass, raced against a timeout because rAF stalls when occluded.
    await Promise.race([
      new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      new Promise<void>((r) => setTimeout(r, 350)),
    ]);
    if (seq !== pauseSeqRef.current) return;
    if (liveRef.current) {
      // Focus came back while the still was painting: nothing was hidden.
      setPauseState('live');
      revoke(pausedImageRef.current);
      setStill(null);
      return;
    }
    setPauseState('paused');
  }, [setPauseState, setStill]);

  // Arm the dwell from a live pane that should not be live. An exemption found
  // when it ends bumps `rearm`, which arms the next dwell: none of the exemptions
  // is render state, so nothing else would re-run this effect once it lapses.
  const [rearm, setRearm] = useState(0);
  useEffect(() => {
    if (pauseState !== 'live' || !heavyNow || !d.ready || !d.isVisible || d.parked || live) return;
    let dropped = false;
    const timer = setTimeout(() => {
      const x = depsRef.current;
      if (dropped || liveRef.current) return;
      const exempt = x.agentActiveRef.current || x.agentOpsInFlightRef.current > 0
        ? Promise.resolve(true)
        : Promise.all([
          tauriInvoke<boolean>('browser_devtools_open', { id: x.id }).catch(() => false),
          tauriInvoke<string>('browser_eval_js', { id: x.id, js: FULL_SCREEN_JS }).catch(() => ''),
        ]).then(([open, fullScreen]) => open === true || fullScreen === '1');
      void exempt.then((keep) => {
        if (dropped || liveRef.current) return;
        if (keep) setRearm((n) => n + 1);
        else void startPause();
      });
    }, PAUSE_DWELL_MS);
    return () => { dropped = true; clearTimeout(timer); };
  }, [live, pauseState, heavyNow, d.ready, d.isVisible, d.parked, startPause, rearm]);

  const resume = useCallback(() => {
    const x = depsRef.current;
    const state = x.pauseStateRef.current;
    if (state === 'live') return;
    ++pauseSeqRef.current;
    if (state === 'pausing') {
      // Nothing is hidden yet: drop the still and stay live.
      setPauseState('live');
      revoke(pausedImageRef.current);
      setStill(null);
      return;
    }
    if (!x.frozenRef.current) {
      // Adopt the pause still as the overlay freeze: from here the pane is in the
      // exact state `freeze()` leaves it in, and existing code owns the return.
      x.frozenRef.current = true;
      ++x.freezeSeqRef.current;
      x.setFrozenImage(pausedImageRef.current);
      void x.paneInvoke('browser_set_bounds', {
        id: x.id, x: -100000, y: 0,
        width: x.lastRealSizeRef.current.width, height: x.lastRealSizeRef.current.height,
      });
    }
    setPauseState('live');
    // Shown only when wanted: a pane paused and then sent behind another tab
    // resumes hidden, and the owner's visibility effect shows it when its tab
    // comes back. Showing it here left the page live with nobody to hide it.
    if (x.isVisible || x.agentActiveRef.current || x.agentOpsInFlightRef.current > 0) {
      void x.setNativeVisible(true).then(() => x.evaluateOcclusionRef.current());
    }
  }, [setPauseState, setStill]);

  // Resume when the pane may be live again.
  useEffect(() => {
    // The focus lives in two external stores and a prop; bringing the native
    // view back is a sync with the shell that has to follow them.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (live && pauseState !== 'live') resume();
  }, [live, pauseState, resume]);

  // The paused still is released once nothing shows it any more.
  useEffect(() => {
    if (pauseState !== 'live' || !pausedImage || d.frozenImage === pausedImage) return;
    revoke(pausedImage);
    // The overlay still that adopted it is dropped by `thaw()` on its own timer;
    // the object URL can only be released once that has happened.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStill(null);
  }, [pauseState, pausedImage, d.frozenImage, setStill]);

  // A reload of the host or an unmount drops the still.
  useEffect(() => () => { ++pauseSeqRef.current; revoke(pausedImageRef.current); }, []);

  // What the verdict needs to know about this pane, and the fallback reader for
  // a document without a status bar polling the shell.
  const shownLive = d.ready && d.isVisible && pauseState === 'live';
  const liveSinceRef = useRef<number | null>(null);
  const navigatedAtRef = useRef<number | null>(null);
  const urlKeyRef = useRef('');
  useEffect(() => {
    const key = urlKeyOf(d.url);
    if (key !== urlKeyRef.current) { urlKeyRef.current = key; navigatedAtRef.current = Date.now(); }
    if (!shownLive) liveSinceRef.current = null;
    else if (liveSinceRef.current === null) liveSinceRef.current = Date.now();
    reportPaneContext(id, { liveSince: liveSinceRef.current, loading: d.loading, navigatedAt: navigatedAtRef.current, urlKey: key });
  }, [id, d.url, d.loading, shownLive]);
  useEffect(() => {
    const release = isTauri ? holdSampleFallback(readPanePerf) : () => {};
    return () => { release(); forgetPane(id); };
  }, [id]);

  const keepOnce = useCallback(() => {
    setKeptOnceKey(urlKeyOf(depsRef.current.url));
    resume();
  }, [resume]);
  const keepAlways = useCallback(() => {
    const o = originOf(depsRef.current.url);
    if (o) {
      const s = loadSettings();
      const cur = s.keepLiveSites ?? [];
      if (!cur.includes(o)) saveSettings({ ...s, keepLiveSites: [...cur, o] });
    }
    resume();
  }, [resume]);

  return { heavy: heavyNow, pauseState, pausedImage, resume, keepOnce, keepAlways };
}
