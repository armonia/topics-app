/**
 * useTauriBrowser — native browser pane for the Tauri shell.
 *
 * Electron renders each browser pane as a WebContentsView (own process) composited
 * over the React layout; the Tauri shell does the same with a real child WKWebView
 * via `Window::add_child` (the `browser_*` Rust commands in src-tauri/src/lib.rs).
 * Far lighter than streaming screenshots over WS, and it's a real browser.
 *
 * This hook returns a `NativeBrowserHandle` (the SAME shape the Electron
 * `useNativeBrowser` returns) so the existing `NativeBrowserPlaceholder` — which
 * owns the hard part, measuring the layout slot and driving `setBounds` — works
 * unchanged. `setBounds` here forwards to `browser_set_bounds`; to HIDE the view
 * (drag in flight, pane not visible, a dropdown overlapping it — native views
 * always composite above the DOM, so z-index can't help) we park it OFF-SCREEN,
 * the Tauri analogue of Electron's `setBounds({0,0,0,0})`.
 *
 * Live: navigation + geometry + show/hide (the "solido" core), DevTools, find-in-page,
 * zoom, device emulation, console capture, downloads, select-element, back/forward
 * history dropdown (getNavEntries → Rust browser_nav_entries over WKBackForwardList).
 * Agent control: observe/act/extract/get_text(ref) run natively via tauriBrowserOps
 * (injected snapshot/act), read_screen/point via the server's Moondream on a native
 * screenshot. Still on streaming: save/load/import login state (no WKHTTPCookieStore
 * bridge yet). url/title/loading arrivano dai NATIVI: WebKit li spinge via KVO, il
 * Rust li mette in coda e il drain di `browser_take_nav_state` la svuota a 250ms su
 * ogni pane, visibile o no. I due poll eval (800ms in primo piano, 2500ms di sfondo)
 * restano come ripiego, unica sorgente fuori da macOS, e portano quello che KVO non
 * dà: favicon, zoom, contatore di fuoco, console. Chi vince quando parlano entrambi
 * sta in `nativeNavIsFresh` (lib/shell/browserPagePoll).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tauriInvoke, currentWindowLabel } from '../lib/shell/tauri';
import { markBrowserViewLive, markBrowserViewDead } from '../lib/shell/nativeBrowserRoster';
import { currentOverlays, decideFreeze, liveSlotRect, onOcclusionChange, type OverlayRect } from '../lib/shell/browserOcclusion';
import { serverWsBase } from '../lib/shell/net';
import { executeNativeBrowserOp } from '../lib/shell/tauriBrowserOps';
import { stepZoom, DEFAULT_ZOOM, zoomApplyJs, zoomDrifted } from '../lib/shell/zoomScale';
import { parseBrowserWsMessage } from '../../../shared/browser-ws-messages';
import {
  DESCRIBE_ELEMENT_FN,
  formatElementContext,
  type ElementDescription,
} from '../../../shared/element-describe';
import { cropToElement } from '../lib/imageCrop';
import { deadLoopbackNotice, isLoopbackUrl, navErrorMessage } from '../components/Browser/navErrorMessage';
import { loopbackAlive } from '../lib/loopbackAlive';
import type { NativeBrowserHandle, DeviceMode, BrowserConsoleEntry, PaneContextTarget } from '@/components/Browser/browserDevTypes';
import { DEVICE_PRESETS, deviceModeFromUserAgent } from '@/components/Browser/browserDevTypes';
import {
  PANE_CONTEXT_HOOK_JS,
  PANE_CONTEXT_TAKE_EXPR,
  PANE_SELECTION_JS,
  IMAGE_COPY_READ_JS,
  imageCopyStartJs,
  parsePaneContextRequest,
  paneToHostPoint,
} from '@/components/Browser/paneContextModel';
import {
  buildReadJs,
  META_JS,
  parsePageState,
  isPageLoading,
  pickNavState,
  nativeNavIsFresh,
} from '../lib/shell/browserPagePoll';
import { NO_FAULT, recordPaneOk, recordPaneError, recreatePane, STRUCTURAL_COMMANDS, type FaultState } from '../lib/shell/browserPaneFault';
import { attemptNativeOpen } from '../lib/shell/nativeBrowserOpen';
import { normalizeUrl } from '@/lib/browserNavUrl';

/** Off-screen X for parking a hidden native view far outside any display — keeps
 *  the webview alive (no reload) while hidden. We park at the last REAL size (not
 *  1×1) so the page keeps a sane layout and stays screenshot-able; see
 *  `lastRealSizeRef` and `applyBounds`. */

/** Idempotently install the self-focus pointerdown counter in the page. Only a
 *  REAL user click into this pane should activate its tab, so we count a
 *  pointerdown ONLY when `e.isTrusted` (excludes agent-driven synthetic ACT_FN
 *  events, isTrusted=false) AND `document.hasFocus()` (true only when this
 *  WKWebView is the app's key/first-responder view — so a pointerdown that
 *  arrives while the user is working in another pane or app, or one WebKit emits
 *  as the view re-attaches under the cursor on a non-key window, is not counted).
 *  Injected by both the READ (800ms) and FAST (120ms) polls; shared verbatim so
 *  whichever runs first installs the identical hook. */
// v2 (__tFocusHook2): the v1 gate only counted clicks with document.hasFocus()
// ALREADY true — but the FIRST click into a non-key WKWebView is exactly what
// makes it key, so hasFocus() was still false at pointerdown and the click
// never counted: the user had to click TWICE to focus the pane's tab. v2 tried
// to also count a click that ACQUIRES focus by re-checking hasFocus() on a
// setTimeout-0 after pointerdown — but WKWebView is multi-process: the web
// content process only learns it's focused via an async IPC round-trip after
// the view becomes first responder, so the 0-tick re-check almost always ran
// BEFORE hasFocus() flipped true. First click still didn't count; two-press
// survived v2 (reported live on 2.1.16).
// v3 (__tFocusHook3): event-driven instead of a timing bet. A trusted
// pointerdown without focus ARMS a short window (600ms); the first `focus`
// event (window- or element-level, captured at window) inside that window
// bumps and disarms. A WebKit stray pointerdown from a set_bounds slide under
// a resting cursor arms but never focuses the view → disarms silently, so the
// original anti-theft property is preserved. Synthetic agent events stay
// excluded via isTrusted; pages that still carry v1/v2 just double-count
// hasFocus-true clicks, which is harmless — the consumer is a change
// detector, not an accumulator.
const INSTALL_FOCUS_HOOK =
  "if(!window.__tFocusHook3){window.__tFocusHook3=1;window.__topicsFocusBump=window.__topicsFocusBump||0;" +
  "var __tFocusArm=0;" +
  "addEventListener('pointerdown',function(e){if(!e.isTrusted)return;" +
  "if(document.hasFocus()){window.__topicsFocusBump++;return;}" +
  "__tFocusArm=Date.now()+600;},true);" +
  "addEventListener('focus',function(){if(__tFocusArm&&Date.now()<=__tFocusArm){__tFocusArm=0;window.__topicsFocusBump++;}},true);}";

/** True while this document is actually on screen.
 *
 *  Every eval poll below crosses into a SEPARATE WKWebView content process
 *  through the Rust shell. Left ungated they keep ticking while the whole app is
 *  occluded (⌘H, minimized, another Space), burning IPC and content-process CPU
 *  for pixels nobody can see — and with the keep-alive ladder there is one such
 *  pane per visited browser tab.
 *
 *  Visibility is the right gate, and `document.hasFocus()` is emphatically NOT:
 *  a click into a native pane makes the CHILD webview key, so the host
 *  document's hasFocus() reads false exactly when a browser pane is in use.
 *  Visibility has no such inversion, and an app that is merely not frontmost
 *  stays `visible` — which keeps the click-that-also-focuses-the-app path
 *  (INSTALL_FOCUS_HOOK's arm window) working. Nothing is lost while hidden:
 *  __topicsFocusBump is a monotonic counter and the page-side console buffer is
 *  capped, so the tick primed on the way back reads the accumulated state. */
const docVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible';

/** Run `fn` whenever the document becomes visible again; returns the unsubscribe. */
function onDocumentVisible(fn: () => void): () => void {
  const handler = (): void => { if (docVisible()) fn(); };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

/** Native browser views are durable across TRANSIENT React unmounts. A project
 *  auto-split moves the browser pane into a NEW group; SplitTree keys its leaf by
 *  group id, so the move remounts `RemoteBrowserPanel` — firing `browser_close(id)`
 *  then `browser_open(id)` on the SAME webview label in one tick. `Webview::close()`
 *  removes the label from Tauri's store SYNCHRONOUSLY but destroys the NSView
 *  asynchronously, so the immediate `browser_open(id)` finds no label and spawns a
 *  SECOND native WKWebView while the first is still tearing down. That orphan has no
 *  React owner, so no later `browser_close` targets it — it stays painted after the
 *  user closes the tab ("the browser won't close", project-only). Fix: defer the
 *  native close by a short grace; a remount for the same contextId cancels it and
 *  REUSES the still-alive view (open hits its idempotent branch). A real close (no
 *  remount) tears down after the grace. Same reap-grace idiom the terminal/browser
 *  self-heal paths already use. */
const pendingBrowserCloses = new Map<string, ReturnType<typeof setTimeout>>();
const BROWSER_CLOSE_GRACE_MS = 350;

/** Quanto un fallimento di navigazione appena letto (drain di
 *  `browser_take_nav_errors`) tiene la barra SPENTA contro un `loading: true`
 *  che arriva dietro di lui. Quel drain gira a 1000ms, quello dello stato nav a
 *  250ms: senza questa finestra la coda coalescata poteva riaccendere una barra
 *  che l'errore aveva appena spento, e a spegnerla non sarebbe più tornato
 *  nessuno finché la pagina non ricaricava. Il fallimento resta l'autorità: è
 *  l'unica cosa che sa che non c'è nessuna pagina in arrivo. */
const NAV_FAIL_GRACE_MS = 1500;

// Live-pane refcount per contextId. A native WKWebView is keyed by contextId and
// SHARED by every pane that mounts under the same id (e.g. the chat tab and a
// co-browse mirror of the same context, or a transient double-mount). Without a
// refcount, the first pane to unmount would fire `browser_close(id)` after the
// grace and destroy the view out from under the sibling that's still visible.
// We only schedule the real close when the LAST reference drops. `mount` cancels
// any pending close; the deferred close double-checks the count is still 0.
const browserViewRefs = new Map<string, number>();
function retainBrowserView(id: string): void {
  browserViewRefs.set(id, (browserViewRefs.get(id) ?? 0) + 1);
}
function releaseBrowserView(id: string): number {
  const next = (browserViewRefs.get(id) ?? 1) - 1;
  if (next <= 0) browserViewRefs.delete(id);
  else browserViewRefs.set(id, next);
  return Math.max(0, next);
}

export function useTauriBrowser(contextId: string, initialUrl?: string, isVisible = true, onFocused?: () => void): NativeBrowserHandle {
  const id = contextId;
  const [ready, setReady] = useState(false);
  const [url, setUrl] = useState(initialUrl ?? '');
  // Mirrors `url` so `recreate()` can reopen at the address the pane is actually
  // showing without taking a dependency that re-creates the callback per keystroke.
  const urlRef = useRef(url);
  urlRef.current = url;
  const [title, setTitle] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [loading, setLoading] = useState(false);
  // Whether the real WKBackForwardList can go back/forward, derived from
  // getNavEntries after each load settles (see the effect below). Drives the
  // toolbar arrows' disabled state — otherwise a click at the end of history is
  // a silent no-op.
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  // Last navigation failure (Rust did-fail queue). Owned by navigate()/the
  // drain poll below — NOT reset by the eval polls, which can't tell a failed
  // load from "still showing the previous page".
  const [navError, setNavError] = useState<{ message: string; url: string; hint?: string } | null>(null);
  /**
   * Scheda PARCHEGGIATA: punta a una porta locale su cui non c'è nessuno in
   * ascolto, quindi la webview nativa non è stata nemmeno creata.
   *
   * Non è un errore di navigazione — non c'è stata nessuna navigazione — ed è
   * per questo che non passa da `navError`: la pane non ha una pagina sotto da
   * lasciare a video, ha una schermata sua.
   */
  const [parked, setParked] = useState<{ url: string; checkedAt: number } | null>(null);
  /** Apre (finalmente) la view per questa pane, e dice se ci è riuscita — chi
   *  ricrea una scheda morta deve poter distinguere «vista nuova in piedi» da
   *  «non è nato niente». Vive solo mentre l'effetto di montaggio è attivo:
   *  serve a `retryParked`, che apre a scoppio ritardato. */
  const openViewRef = useRef<((url: string) => Promise<boolean>) | null>(null);
  const [consoleEntries, setConsoleEntries] = useState<BrowserConsoleEntry[]>([]);
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop');
  // Mirrors `deviceMode` for the UA reconcile below, which must read the current
  // mode without listing it as a dependency (that would re-run the eval on every
  // switch, to re-derive the mode the user just picked).
  const deviceModeRef = useRef<DeviceMode>('desktop');
  deviceModeRef.current = deviceMode;
  const [responsiveSize, setResponsiveSizeState] = useState<{ width: number; height: number } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  // Il tasto destro raccolto dentro la pagina, già in coordinate della finestra.
  // Lo riempie il poll veloce (120ms), lo svuota chi chiude il menu.
  const [paneContext, setPaneContext] = useState<PaneContextTarget | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [agentAction, setAgentAction] = useState<string | null>(null);
  // Page zoom percent (CSS-driven via exec_js). Reactive so the toolbar's zoom
  // label reflects both button and keyboard changes from one source of truth.
  const [zoom, setZoomState] = useState(DEFAULT_ZOOM);
  const zoomRef = useRef(DEFAULT_ZOOM);
  const consoleIdRef = useRef(0);

  // ── Is this pane still alive? ─────────────────────────────────────────────
  // Every native command used to end in `.catch(() => {})` — twenty-one of them
  // in this file. A pane whose webview had stopped answering (the poisoned
  // dispatcher mutex `no_abort` exists to survive, see browserPaneFault) went on
  // looking exactly like a working one: the chrome renders from React state, so
  // the address bar, the title and the favicon all stay put while every command
  // underneath returns Err into a swallowing catch. Now the structural commands
  // report, and a streak of failures becomes something the pane can SAY.
  const [fault, setFault] = useState<FaultState>(NO_FAULT);
  const faultRef = useRef<FaultState>(NO_FAULT);
  const commitFault = useCallback((next: FaultState) => {
    if (next === faultRef.current) return; // recordPaneOk returns the same object when nothing changed
    faultRef.current = next;
    setFault(next);
  }, []);
  /**
   * Fire a native command and let it be counted. Resolves true when the shell
   * accepted it, false when it didn't — so a caller can react instead of
   * discarding the outcome, and nothing is thrown at a caller that has no
   * meaningful recovery. Non-structural commands pass through uncounted.
   */
  const paneInvoke = useCallback(
    (cmd: string, args: Record<string, unknown>): Promise<boolean> =>
      tauriInvoke(cmd, args).then(
        () => {
          if (STRUCTURAL_COMMANDS.has(cmd)) commitFault(recordPaneOk(faultRef.current));
          return true;
        },
        (e: unknown) => {
          if (STRUCTURAL_COMMANDS.has(cmd)) {
            const next = recordPaneError(faultRef.current, cmd);
            if (next.faulted && !faultRef.current.faulted) {
              console.warn(`[tauri-browser] pane ${id} looks dead: ${cmd} failed ${next.streak}×`, e);
            }
            commitFault(next);
          }
          return false;
        },
      ),
    [commitFault, id],
  );

  /**
   * Put the zoom back on a document that has lost it.
   *
   * Called from both polls with the inline zoom the page just reported. Zoom
   * lives on the DOCUMENT, so every navigation hands the pane a fresh one at
   * 100% while the toolbar goes on showing the percentage the user chose (see
   * zoomScale). Re-asserting from the tick that already read the page costs no
   * extra IPC on the common path — at 100% nothing has drifted, so nothing is
   * sent — and it heals every way a document can be replaced, including the
   * device switcher's deliberate reload and a link the user clicks in the page.
   */
  const reassertZoom = useCallback(
    (reportedZoomStyle: string) => {
      const want = zoomRef.current;
      if (!zoomDrifted(want, reportedZoomStyle)) return;
      void tauriInvoke('browser_exec_js', { id, js: zoomApplyJs(want) }).catch(() => {});
    },
    [id],
  );
  const selectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Direction-B focus bridge: a click inside a native WKWebView pane never
  // reaches the React DOM, so the pane can't activate its own tab. The poll
  // reads an injected pointerdown counter; `-1` baselines the first read so
  // mounting doesn't self-activate. onFocused is kept in a ref so the poll
  // effect doesn't re-subscribe when the parent passes a fresh closure.
  const lastFocusBumpRef = useRef(-1);
  const onFocusedRef = useRef(onFocused);
  onFocusedRef.current = onFocused;
  // Focus-theft guard. The self-focus signal must be a REAL click INTO this pane,
  // not a side effect of the pane moving/appearing. Two independent gates:
  //  1. in-page (READ/FAST): the pointerdown listener only counts `isTrusted`
  //     events fired while `document.hasFocus()` — i.e. the user is genuinely
  //     interacting with THIS WKWebView while it's the app's key view. A stray
  //     activation press, an agent's synthetic (isTrusted=false) event, or a
  //     pointerdown that lands while the user is typing in another pane/app all
  //     fail this and never increment the counter.
  //  2. client-side (this ref): a `browser_set_bounds` that slides the live view
  //     UNDER a resting cursor, or a thaw/create re-attach, can make WebKit emit
  //     a trusted pointerdown to the view even though the user didn't click into
  //     it. After any such reflow we suppress the signal briefly — bumps observed
  //     while suppressed are re-baselined (recorded, never fired), so the tab
  //     doesn't yank itself active when a pane simply repositions beneath the mouse.
  const focusSuppressUntilRef = useRef(0);
  const suppressSelfFocus = useCallback(() => {
    focusSuppressUntilRef.current = Date.now() + 400;
  }, []);
  // Shared bump→activate decision for BOTH polls (800ms READ + 120ms FAST). A
  // growing counter means a trusted, in-focus click landed in this pane; fire
  // onFocused unless we're inside the post-reflow suppression window. Always
  // re-baseline so a suppressed or first-read bump is recorded (compare+set is
  // synchronous — no await between — so the two polls never double-fire one click).
  const maybeFireSelfFocus = useCallback((bump: number) => {
    const grew = lastFocusBumpRef.current >= 0 && bump > lastFocusBumpRef.current;
    lastFocusBumpRef.current = bump;
    if (grew && Date.now() >= focusSuppressUntilRef.current) onFocusedRef.current?.();
  }, []);
  // Device emulation: when set, the pane is letterboxed to these dims inside its
  // layout slot (centered) + a device UA is applied. null = desktop (full slot).
  const deviceDimsRef = useRef<{ width: number; height: number } | null>(null);

  const openedRef = useRef(false);
  // Buffer the last requested SLOT rect (the layout cell), flushed once the
  // webview exists and re-used to recompute bounds on device-mode changes.
  const pendingRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  // Last size the view was actually SHOWN at. When we park the view off-screen
  // (hidden pane, drag, overlay), we keep it at THIS size — NOT collapsed to 1×1
  // — so the page retains a real layout (innerWidth/vh/vw) and stays screenshot-
  // able. A background/agent-driven pane that's never been foregrounded is the
  // reason for the default: without it the WKWebView renders at 1×1 and every
  // vh/vw collapses, so browser_status/screenshot see a 1×1 page. Seeded to the
  // same 800×600 the view is created at (see browser_open below).
  const lastRealSizeRef = useRef<{ width: number; height: number }>({ width: 800, height: 600 });
  const initialUrlRef = useRef(initialUrl);

  // ── Freeze-frame ──────────────────────────────────────────────────────────
  // A native child WKWebView ALWAYS composites above the DOM, so it can't be
  // z-ordered under a dropdown nor cheaply moved per-frame. When an HTML overlay
  // opens over it, or a sidebar/divider animation is in flight, we capture a PNG
  // still (browser_screenshot), show it as a DOM <img> in the placeholder, and
  // park the live view off-screen. Overlays then render over the still by normal
  // z-index (the page no longer vanishes), and animations move the cheap image,
  // not the native view. `frozenRef` makes applyBounds a no-op while frozen so the
  // placeholder's bounds-tracking can't re-park/thrash; `freezeSeqRef` correlates
  // each freeze/thaw so a rapid toggle never shows a stale still.
  const [frozenImage, setFrozenImage] = useState<string | null>(null);
  const frozenRef = useRef(false);
  const freezeSeqRef = useRef(0);
  const thawTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply the effective bounds = the last slot rect, letterboxed to the device
  // dims when emulating. Centralised so device-mode switches can re-letterbox
  // without the placeholder re-measuring.
  const applyBounds = useCallback(() => {
    // While frozen the live view is parked behind a DOM still; ignore every
    // bounds push (poll / ResizeObserver / device switch) so nothing re-parks or
    // re-shows it mid-overlay/animation. thaw() restores it via reflow-request.
    if (frozenRef.current) return;
    const slot = pendingRectRef.current;
    if (!slot || !openedRef.current) return;
    // Overlay-hiding is handled by the freeze path (intersection-scoped), not here.
    const hide = slot.width <= 0 || slot.height <= 0;
    let rect = slot;
    const dims = deviceDimsRef.current;
    if (!hide && dims) {
      const w = Math.min(dims.width, slot.width);
      const h = Math.min(dims.height, slot.height);
      rect = { x: slot.x + (slot.width - w) / 2, y: slot.y + (slot.height - h) / 2, width: w, height: h };
    } else if (hide) {
      // Park off-screen but KEEP the last shown size (not 1×1), so the page's
      // layout survives while hidden and the agent can still screenshot/read it.
      rect = { x: -100000, y: 0, width: lastRealSizeRef.current.width, height: lastRealSizeRef.current.height };
    }
    // Remember the real on-screen size so a later park preserves the page layout.
    // Floor at 64px so a transient tiny rect mid-animation can't poison the park
    // size (which would re-collapse the page layout when the pane next hides).
    if (!hide && rect.width >= 64 && rect.height >= 64) {
      lastRealSizeRef.current = { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    // Floating-mode signal for the shell's corner mask: floating cards keep a
    // margin from the window edge, so the shell widens its "meets a window
    // corner" tolerance when this is non-zero. Rounding happens ONLY at window
    // corners (Attilio's ruling) — the value itself is not a corner radius.
    const radius = document.querySelector('.floating-splits') ? 10 : 0;
    // Moving the live view can slide it under the cursor and make WebKit emit a
    // trusted pointerdown that isn't a real click-in — suppress self-focus across
    // the move (only when actually showing; a hide/park can't be misread).
    if (!hide) suppressSelfFocus();
    void paneInvoke('browser_set_bounds', {
      id,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radius,
    });
  }, [id, suppressSelfFocus, paneInvoke]);

  const setBounds = useCallback(
    (b: { x: number; y: number; width: number; height: number }) => {
      if (b.width > 0 && b.height > 0) {
        pendingRectRef.current = b; // remember the real SLOT rect
        applyBounds(); // show (letterboxed if emulating; off-screen if occluded)
      } else if (openedRef.current) {
        // Explicit zero-rect = hide (drag/resize in flight, pane inactive, or an
        // HTML overlay over it — native views composite above the DOM). Park it
        // off-screen at the last real size (NOT 1×1) so the page keeps its layout
        // and stays screenshot-able; the next real rect restores it on-screen.
        void paneInvoke('browser_set_bounds', {
          id, x: -100000, y: 0,
          width: lastRealSizeRef.current.width, height: lastRealSizeRef.current.height,
        });
      }
    },
    [applyBounds, id, paneInvoke],
  );

  // Sidebar-slide handoff: commit the pane's FINAL slot in ONE IPC and let Core
  // Animation ride the native view along the same 200ms curve as the DOM FLIP
  // (browser_animate_bounds) — replaces the per-frame rAF chase whose IPC jitter
  // made the pane edge visibly stutter against the composited content slide.
  // Resolves false when the handoff can't run (shell without the command, pane
  // not open) so the caller falls back to the poll. While frozen the live view
  // is parked behind a DOM still that rides the FLIP layer for free — resolve
  // true so the caller skips the poll (applyBounds is a no-op anyway).
  const animateBounds = useCallback(
    (
      b: { x: number; y: number; width: number; height: number },
      fromDx: number,
      durationMs: number,
      timing: [number, number, number, number],
    ): Promise<boolean> => {
      if (frozenRef.current) return Promise.resolve(true);
      if (!openedRef.current || b.width <= 0 || b.height <= 0) return Promise.resolve(false);
      pendingRectRef.current = b;
      let rect = b;
      const dims = deviceDimsRef.current;
      if (dims) {
        const w = Math.min(dims.width, b.width);
        const h = Math.min(dims.height, b.height);
        rect = { x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h };
      }
      if (rect.width >= 64 && rect.height >= 64) {
        lastRealSizeRef.current = { width: Math.round(rect.width), height: Math.round(rect.height) };
      }
      const radius = document.querySelector('.floating-splits') ? 10 : 0;
      // The animated move can slide the view under a resting cursor — same
      // trusted-pointerdown hazard as a plain reposition.
      suppressSelfFocus();
      return paneInvoke('browser_animate_bounds', {
        id,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fromDx: Math.round(fromDx),
        durationMs,
        timing,
        radius,
      });
    },
    [id, suppressSelfFocus, paneInvoke],
  );

  // Capture a still, show it, then park the live view. Capturing FIRST (while the
  // view is on-screen) is necessary but NOT sufficient for a seamless swap: the
  // still must also have PAINTED before the view parks. setFrozenImage only
  // schedules a React commit — the <img> then still has to decode the PNG and
  // composite, which lands frames after the park IPC if we fire it right away.
  // That gap (native view gone, still not painted yet) was the visible "flash"
  // every time a dropdown opened over a pane. So: decode the bitmap off-DOM
  // first, commit the still, wait two rAFs for the composite, THEN park.
  const freeze = useCallback(() => {
    if (!openedRef.current || frozenRef.current) return;
    frozenRef.current = true; // applyBounds is now a no-op — the poll can't fight us
    const seq = ++freezeSeqRef.current;
    if (thawTimerRef.current) { clearTimeout(thawTimerRef.current); thawTimerRef.current = null; }
    void tauriInvoke<string>('browser_screenshot', { id })
      .then(async (data) => {
        if (freezeSeqRef.current !== seq || !data) return;
        const url = `data:image/png;base64,${data}`;
        // Pre-decode so the <img> paints on its very first frame (decode() warms
        // WebKit's image cache for the identical data URL). Failure is benign —
        // the still just decodes lazily like before.
        try { const im = new Image(); im.src = url; await im.decode(); } catch { /* decode is best-effort */ }
        if (freezeSeqRef.current !== seq) return;
        setFrozenImage(url);
        // Two rAFs: one for the React commit, one for the composite with the
        // still actually on-glass. Only then is it safe to yank the live view.
        // Raced against a timeout because rAF stalls in an occluded window —
        // the park must still happen so the overlay isn't stuck underneath.
        await Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          new Promise<void>((r) => setTimeout(r, 350)),
        ]);
      })
      .catch(() => {})
      .finally(() => {
        // Park (even if the shot failed — the overlay must show through);
        // skip if a thaw already superseded this freeze. Park at the last real size
        // (off-screen), not 1×1, so the page layout survives behind the still.
        if (freezeSeqRef.current === seq) void paneInvoke('browser_set_bounds', {
          id, x: -100000, y: 0,
          width: lastRealSizeRef.current.width, height: lastRealSizeRef.current.height,
        });
      });
  }, [id, paneInvoke]);

  // Restore the live view at the real slot, then drop the still once the view is
  // surely back on top (it composites above the DOM, so an overlapping image
  // underneath is invisible — a generous delay is artifact-free).
  const thaw = useCallback(() => {
    if (!frozenRef.current) return;
    frozenRef.current = false;
    const seq = ++freezeSeqRef.current;
    // Re-attaching the live view can draw a trusted pointerdown that isn't a
    // click-in — don't let the thaw steal the tab.
    suppressSelfFocus();
    // Bring the view back OURSELVES, now that `frozenRef` is false and
    // applyBounds is no longer a no-op.
    //
    // This used to be the reflow-request alone, and that made the return of a
    // parked view depend on a listener elsewhere in the tree scheduling two
    // nested rAFs — while the still image is dropped 240ms later by a plain
    // setTimeout, which has no such dependency. `freeze()` already knows rAF
    // stalls in an occluded window (it races its park against a 350ms timeout
    // for exactly that reason); `thaw()` did the opposite job with no such
    // guard, so the two could come apart: still gone, live view still parked at
    // x=-100000, an empty pane that stays empty until something unrelated
    // happens to re-measure it.
    //
    // Also what finally lands the device switcher's letterbox: picking a preset
    // from a MENU means an overlay is over the pane, so the `applyBounds()`
    // inside `setDevice` is guaranteed to hit the frozen no-op. The pane's
    // shape now settles when the menu closes, from the same call.
    applyBounds();
    // Second pass: `pendingRectRef` is the last rect the placeholder computed,
    // and the layout may have moved while we were frozen. This corrects it.
    window.dispatchEvent(new CustomEvent('browser:reflow-request'));
    if (thawTimerRef.current) clearTimeout(thawTimerRef.current);
    thawTimerRef.current = setTimeout(() => {
      if (freezeSeqRef.current === seq) setFrozenImage(null);
    }, 240);
  }, [suppressSelfFocus, applyBounds]);

  // Overlay occlusion: freeze ONLY while an overlay actually intersects THIS pane's
  // slot (a menu elsewhere leaves it untouched), so the still shows through and the
  // overlay renders over it; thaw when nothing covers it anymore. Replaces the old
  // global off-screen park, whose 30ms-debounce vs per-frame-poll race left a
  // visible 20-50ms vanish — and which hid every pane for any overlay anywhere.
  //
  // UNA sola porta per la decisione, perché non la chiede solo l'arrivo di un
  // overlay: anche la pane che si APRE mentre un modale è già aperto deve
  // deciderlo, e in quel momento non sta cambiando niente — nessuna notifica
  // arriverebbe mai, e la webview appena creata si disegnerebbe sopra il modale
  // restandoci fino alla sua chiusura.
  const evaluateOcclusion = useCallback((rects: readonly OverlayRect[] = currentOverlays()) => {
    if (!openedRef.current) return;
    // Il rettangolo VIVO dal DOM, non quello chiesto l'ultima volta alla vista
    // nativa: la cache non si aggiorna quando la vista si parcheggia, e basta
    // uno split ridimensionato perché descriva un posto che non esiste più.
    // La cache resta come ripiego finché lo slot non è nel DOM (montaggio).
    const slot = liveSlotRect(id) ?? pendingRectRef.current;
    if (decideFreeze(slot, rects)) freeze(); else thaw();
  }, [freeze, thaw, id]);
  const evaluateOcclusionRef = useRef(evaluateOcclusion);
  evaluateOcclusionRef.current = evaluateOcclusion;

  useEffect(() => onOcclusionChange((rects) => evaluateOcclusion(rects)), [evaluateOcclusion]);

  // NOTE: deliberately NO freeze-on-sidebar-animation. Hiding the live pane behind
  // a still just to survive the slide would be a kludge (same family as blanking
  // terminals during a resize). The structural fixes are: overlay-sidebar mode
  // (constant content width → the pane never moves) and disabling the WKWebView's
  // implicit Core Animation so the per-frame moves of PUSH mode are cheap (see
  // browser_open in src-tauri/src/lib.rs). Freeze stays scoped to its one
  // unavoidable case: an HTML overlay that must composite over the native view.

  // Drop a pending thaw timer on unmount.
  useEffect(() => () => { if (thawTimerRef.current) clearTimeout(thawTimerRef.current); }, []);

  // ── Native visibility (NOT geometry) ──────────────────────────────────────
  // Parking a pane off-screen AT FULL SIZE — what `applyBounds`/`setBounds` do
  // above — hides it from the user but not from WebKit: visibility is derived
  // from the view's hidden flag and window occlusion, never from its position or
  // rect. So every background pane stayed a fully live page — rAF firing, timers
  // unthrottled, whole render tree retained. Measured with ~20 panes open: 20
  // live WebContent processes holding 6374 MB of footprint against ~130 MB
  // actually resident, the OS having compressed the difference. Paging that back
  // in is what made the UI stutter, and it is why the pane count showed up as an
  // FPS problem rather than just a memory one.
  //
  // `browser_set_visible` calls setHidden:, flipping WebKit's
  // ActivityState::IsVisible → the page goes to visibilityState "hidden": rAF
  // stops, timers throttle, memory becomes reclaimable. What Safari does to
  // background tabs.
  //
  // EXCEPT when an agent is driving this pane. A hidden NSView can't be
  // snapshotted, and background panes are exactly where agent-driven
  // screenshot/read_screen ops run (the `browser_op` delegation below), so a pane
  // that's agent-active — or has a delegated op in flight — stays live even while
  // off-screen. It's parked at x=-100000, so "live" here never means "visible".
  const nativeVisibleRef = useRef(true);
  const agentOpsInFlightRef = useRef(0);
  // Read inside the WS effect (deps [id]) without re-subscribing it per change.
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const agentActiveRef = useRef(agentActive);
  agentActiveRef.current = agentActive;

  /** Returns true if this call actually changed the native visibility. */
  const setNativeVisible = useCallback(async (visible: boolean): Promise<boolean> => {
    if (!openedRef.current || nativeVisibleRef.current === visible) return false;
    nativeVisibleRef.current = visible;
    await paneInvoke('browser_set_visible', { id, visible });
    return true;
    // paneInvoke is useCallback([commitFault, id]) and commitFault is
    // useCallback([]) — so this stays stable per contextId, which is what the
    // socket effect below relies on to avoid re-subscribing.
  }, [id, paneInvoke]);

  useEffect(() => {
    if (!ready) return;
    void setNativeVisible(isVisible || agentActive || agentOpsInFlightRef.current > 0);
    // Una pane che TORNA visibile (cambio di scheda con una scorciatoia, un
    // pannello che si riapre) rientra in scena senza che nessun overlay si sia
    // mosso: stessa cecità dell'apertura, stesso rimedio — si guarda com'è il
    // mondo adesso invece di aspettare un cambiamento che non arriverà.
    if (isVisible) evaluateOcclusionRef.current();
  }, [ready, isVisible, agentActive, setNativeVisible]);

  // Create the native webview once per contextId; close on unmount. (Electron
  // keeps the view durable across unmount; for Tier-1 we close — simpler, and a
  // re-mount just re-opens. Revisit if tab-switch churn proves costly.)
  useEffect(() => {
    let cancelled = false;
    // A remount within the grace window (project auto-split re-key) lands here
    // while the previous cleanup's deferred close is still queued — cancel it so
    // the still-alive native view is REUSED instead of destroyed-then-orphaned.
    const queuedClose = pendingBrowserCloses.get(id);
    if (queuedClose) { clearTimeout(queuedClose); pendingBrowserCloses.delete(id); }
    retainBrowserView(id);
    const wantedUrl = normalizeUrl(initialUrlRef.current ?? 'about:blank');
    // Una scheda verso una porta LOCALE non parte alla cieca: si chiede prima al
    // server se lì c'è ancora qualcuno in ascolto.
    //
    // Perché proprio qui: le schede sono persistite con la loro URL e moltissime
    // puntano all'ANTEPRIMA di un task — un server effimero che muore con la
    // sessione dell'agente mentre la URL resta salvata per sempre. Riaprire quel
    // task faceva partire una richiesta destinata a fallire e lasciava a video la
    // pagina d'errore di WebKit, muta su cosa mancasse.
    //
    // La view si crea SUBITO su about:blank e la navigazione arriva dopo la
    // risposta: la sonda è su loopback (millisecondi) ma non deve comunque stare
    // sul percorso critico della creazione, che è quello che tiene la pane su
    // «Initializing native browser…».
    const gateLoopback = isLoopbackUrl(wantedUrl);
    // isolate: each pane gets its OWN persistent WKWebsiteDataStore keyed on the
    // contextId (stable across restarts) — per-topic cookie/localStorage
    // isolation, matching Electron's persist:topic-<contextId> partition. One
    // time cost: panes that had been living in the shared default store lose that
    // login once on this switch (recoverable via browser_import_chrome /
    // browser_load_state). macOS 14+; degrades to the shared store on older.
    // browser_open is idempotent on an existing label (lib.rs), so reusing a view
    // whose close we just cancelled simply re-shows it.
    markBrowserViewLive(id);
    const applyOpened = () => {
        openedRef.current = true;
        // NON fidarsi del `true` iniziale di `nativeVisibleRef`: la view che
        // `browser_open` ha appena restituito può essere una view RIUSATA, e
        // il suo ramo idempotente (lib.rs) fa solo navigate + set_bounds —
        // non chiama mai `show()`. Se la ref dice già `true`, il primo
        // `setNativeVisible(true)` esce subito come no-op e la view resta
        // `setHidden:YES`: la pane si apre con la sua toolbar e sotto NIENTE.
        //
        // È lo scenario comune, non un caso limite: le pane browser non
        // vengono mai sfrattate (RESIDENCY_BUDGET.native = Infinity), quindi
        // una tab di sfondo resta montata e nascosta; un ⌘R non smonta la
        // webview figlia (le pane la RIUSANO, vedi nativeBrowserRoster.ts) ma
        // azzera il registro di residenza, che è in memoria. Alla prima
        // riattivazione la pane monta già attiva, la ref è `true`, e nessuno
        // riaccende la view.
        //
        // Si segna l'OPPOSTO di quello che il primo giro chiederà, non un
        // `false` fisso: una view APPENA CREATA nasce visibile (`add_child`
        // senza `.visible(false)`), quindi fissare `false` romperebbe il caso
        // speculare — pane che monta dovendo restare nascosta, no-op, e la
        // view resta accesa. Così invece la prima chiamata è una transizione
        // vera in ENTRAMBI i versi, e `browser_set_visible` fa da autorità
        // qualunque fosse lo stato reale della view riusata.
        //
        // La DECISIONE resta quella di prima (`isVisible || agentActive ||
        // agentOpsInFlight`): non si riaccendono le pane di sfondo, che è il
        // motivo per cui `browser_set_visible` esiste.
        nativeVisibleRef.current = !(
          isVisibleRef.current || agentActiveRef.current || agentOpsInFlightRef.current > 0
        );
        setReady(true);
        // La barra mostra la URL VOLUTA anche quando la view è ferma su
        // about:blank perché la porta è spenta: è l'indirizzo di questa scheda,
        // e farlo sparire la renderebbe anonima proprio nel momento in cui serve
        // sapere quale porta non risponde.
        setUrl(wantedUrl === 'about:blank' ? '' : wantedUrl);
        if (pendingRectRef.current) setBounds(pendingRectRef.current);
        // …e SUBITO dopo averla messa al suo posto, guardare se quel posto è
        // già coperto. Fin qui l'occlusione la decideva soltanto l'arrivo di un
        // overlay: una pane che si apre sotto un modale GIÀ aperto non riceveva
        // mai quella notifica — non stava cambiando niente — e la webview
        // nativa, che composita sopra il DOM, restava sopra il modale finché
        // qualcuno non lo chiudeva. `openedRef` è appena diventato vero, quindi
        // la valutazione (che si ferma sulle pane non aperte) ora conta.
        evaluateOcclusionRef.current();
    };
    // browser_open used to fail silently: a transient IPC/shell hiccup left the
    // pane stuck on "Initializing native browser…" forever, with no signal to
    // the user and no recovery. Do one bounded retry, then surface the failure
    // in the nav-error strip so the pane can offer a retry instead of hanging.
    // I due rami di `attemptNativeOpen` sono già tutto ciò che serve a rimettere
    // a posto lo stato; questa promessa non li sposta, li ASCOLTA — perché chi
    // RICREA una scheda morta è l'unico chiamante che deve sapere se sotto c'è
    // di nuovo una vista, prima di lasciar cadere il guasto.
    const attemptOpen = (openUrl: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        attemptNativeOpen({
          // windowLabel: la webview nativa deve nascere figlia della finestra che
          // ospita QUESTA pane (pop-out inclusi), non sempre di `main` — vedi
          // browser_open_inner in lib.rs. Fuori da Tauri currentWindowLabel() è null.
          invoke: () => tauriInvoke('browser_open', { id, url: openUrl, x: -100000, y: 0, width: 800, height: 600, isolate: true, windowLabel: currentWindowLabel() ?? 'main' }),
          // È anche l'ultimo posto da cui si passa quando la pane viene smontata
          // a metà apertura: chi aspetta l'esito riceve un `false` invece di
          // restare appeso a una promessa che nessuno risolverà più.
          isCancelled: () => { if (!cancelled) return false; resolve(false); return true; },
          onOpened: () => { applyOpened(); resolve(true); },
          onGaveUp: () => {
            setNavError({ message: 'Impossibile aprire il browser nativo. Riprova.', url: openUrl });
            // Chi ha chiesto l'apertura ha acceso la barra e non aspetta l'esito
            // (`navigate` e «Riprova» del parcheggio non lo leggono): se non la
            // spegne questo ramo, resta accesa per sempre — nessuno dei punti che
            // la spengono gira finché `ready` è falso — e il rollup di progetto
            // conta la pane occupata a vita.
            setLoading(false);
            resolve(false);
          },
        });
      });
    // Kept for EVERY pane, not just the loopback-gated ones: it is how a pane
    // that has been declared dead gets rebuilt (`recreate` below), and how a
    // parked tab opens late. It used to be set only inside the gated branch, so
    // an ordinary https pane had no way back once its webview stopped answering.
    openViewRef.current = (u: string) => (cancelled ? Promise.resolve(false) : attemptOpen(u));
    if (!gateLoopback) {
      void attemptOpen(wantedUrl);
    } else {
      // La sonda PRIMA dell'apertura, non dopo: aprire su about:blank e navigare
      // alla risposta farebbe lampeggiare bianca ogni pane su un server locale
      // VIVO, a ogni rimontaggio (l'auto-split ne fa parecchi), e su una view
      // RIUSATA butterebbe via la pagina che stava già mostrando —
      // `browser_open` è idempotente e il suo ramo di riuso naviga. Costa un
      // giro su loopback, che su una porta rifiutata è immediato: il timeout da
      // 300ms riguarda una porta filtrata, cosa che in locale non capita.
      void loopbackAlive(wantedUrl).then((alive) => {
        if (cancelled) return;
        if (!alive) {
          // Nessuna webview: una pane bianca non serve a niente e costa una
          // WKWebView con il suo data store. La scheda resta PARCHEGGIATA e al
          // suo posto il pannello disegna una schermata che dice cosa manca.
          setParked({ url: wantedUrl, checkedAt: Date.now() });
          return;
        }
        void attemptOpen(wantedUrl);
      });
    }
    return () => {
      cancelled = true;
      openViewRef.current = null;
      openedRef.current = false;
      // Defer the native close: a real close fires it after the grace; a transient
      // remount (auto-split) cancels it above. This decouples React unmount churn
      // from Webview::close()'s two-phase (sync label-drop, async NSView destroy)
      // teardown, which otherwise orphans a native view on close+open same tick.
      const existing = pendingBrowserCloses.get(id);
      if (existing) clearTimeout(existing);
      // Only the LAST live pane for this contextId may close the shared view.
      // If a sibling pane still references it, drop our ref and leave the view
      // alone — closing here would blank the sibling.
      if (releaseBrowserView(id) > 0) return;
      markBrowserViewDead(id);
      pendingBrowserCloses.set(id, setTimeout(() => {
        pendingBrowserCloses.delete(id);
        // Re-check under the grace: a remount may have re-retained the id.
        if ((browserViewRefs.get(id) ?? 0) > 0) return;
        void tauriInvoke('browser_close', { id }).catch(() => {});
      }, BROWSER_CLOSE_GRACE_MS));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once per contextId; initialUrl is captured via ref so a persisted-url change never re-creates the view
  }, [id]);

  /**
   * Chiedere la webview a chi la sa costruire, con la barra già accesa.
   *
   * `openViewRef` è vivo solo fra il montaggio dell'effetto e il suo cleanup:
   * fuori da lì la richiesta cade nel vuoto, e senza questo ramo la barra che
   * il chiamante ha appena acceso non la spegnerebbe più nessuno.
   *
   * Restituisce l'esito per chi lo aspetta (`recreate`): una ref morta è un
   * `false`, non un silenzio.
   */
  const requestOpenView = useCallback((u: string): Promise<boolean> => {
    const open = openViewRef.current;
    if (!open) { setLoading(false); return Promise.resolve(false); }
    return open(u);
  }, []);

  const navigate = useCallback(
    async (u: string) => {
      const norm = normalizeUrl(u);
      setUrl(norm === 'about:blank' ? '' : norm);
      setLoading(true);
      setNavError(null); // a fresh attempt owns the strip
      // Una scheda parcheggiata non ha una webview da navigare: chi digita un
      // altro indirizzo (o un agente che manda la pane altrove) la sparcheggia e
      // se la fa aprire adesso.
      if (parked) {
        setParked(null);
        void requestOpenView(norm);
        return;
      }
      // Only the page's own readyState clears the bar (see isPageLoading). This
      // used to also arm a blind `setTimeout(…, 700)`, 100ms out of step with the
      // 800ms poll that re-derived the same boolean from the page: the timer
      // switched the bar off, the next tick found the page still loading and
      // switched it back on, for as long as the load took. That was the flicker.
      if (!(await paneInvoke('browser_navigate', { id, url: norm }))) setLoading(false);
    },
    [id, parked, paneInvoke, requestOpenView],
  );

  /**
   * Il «Riprova» della strip d'errore, che non è un `navigate` qualunque.
   *
   * Su una porta locale spenta ricaricare non può funzionare, e ricaricando non
   * cambiava NIENTE a video: stessa strip, stesso testo — il bottone sembrava
   * rotto. Qui si sonda prima: se è ancora morta la risposta è la stessa frase
   * con l'ora aggiornata, che è il modo di dire «ho guardato adesso». Se nel
   * frattempo qualcuno ha riacceso quel server, si naviga davvero.
   */
  const retryNav = useCallback(
    async (u: string) => {
      const target = normalizeUrl(u);
      if (isLoopbackUrl(target) && !(await loopbackAlive(target))) {
        setNavError({ ...deadLoopbackNotice(target, new Date()), url: target });
        return;
      }
      await navigate(target);
    },
    [navigate],
  );

  /**
   * Il «Riprova» della scheda parcheggiata: si torna a chiedere se su quella
   * porta è comparso qualcuno. Se sì la view si apre adesso; se no cambia l'ora
   * del controllo, che è il modo di dire «ho guardato di nuovo, ancora niente»
   * invece di lasciare un bottone che non fa niente di visibile.
   */
  const [parkedChecking, setParkedChecking] = useState(false);
  const retryParked = useCallback(async () => {
    const target = parked?.url;
    if (!target || parkedChecking) return;
    setParkedChecking(true);
    try {
      const alive = await loopbackAlive(target);
      if (!alive) { setParked({ url: target, checkedAt: Date.now() }); return; }
      setParked(null);
      setLoading(true);
      void requestOpenView(target);
    } finally {
      setParkedChecking(false);
    }
  }, [parked, parkedChecking, requestOpenView]);

  const clearNavError = useCallback(() => setNavError(null), []);

  const reload = useCallback(async () => {
    setLoading(true);
    if (!(await paneInvoke('browser_reload', { id }))) setLoading(false);
  }, [id, paneInvoke]);

  // Real WKWebView history nav (browser_back/forward) — not the old re-navigate
  // hack. The state poll below reflects the resulting url/title back into the UI.
  const goBack = useCallback(async () => {
    setLoading(true);
    if (!(await paneInvoke('browser_back', { id }))) setLoading(false);
  }, [id, paneInvoke]);
  const goForward = useCallback(async () => {
    setLoading(true);
    if (!(await paneInvoke('browser_forward', { id }))) setLoading(false);
  }, [id, paneInvoke]);
  const goHome = useCallback(async () => navigate(initialUrlRef.current ?? 'about:blank'), [navigate]);

  // ── Live state poll ──────────────────────────────────────────────────────
  // WKWebView's navigation-delegate load events aren't bridged, so a poll is the
  // robust way to keep the address bar, tab title and favicon in sync with what
  // the page actually does — IN-PAGE link clicks, redirects and SPA route
  // changes included (the old hook only updated `url` on explicit navigate(), so
  // clicking a link left the address bar stale). One cheap `browser_eval_js`
  // read per tick; `loading` is driven off the real document.readyState.
  useEffect(() => {
    // Only poll the VISIBLE pane. With the keep-alive ladder every visited browser pane
    // stays mounted (display:none when inactive), so an ungated poll runs a browser_eval_js
    // round-trip every 800ms for EACH backgrounded pane. Gate on isVisible (same signal the
    // streaming variant uses for the screencast); when a pane re-shows, this effect re-runs
    // and primes a fresh tick immediately. The page-side console buffer stays capped at 500
    // (CONSOLE_PROXY_JS) while unobserved, so nothing is lost.
    if (!ready || !isVisible) return;
    let stop = false;
    let inFlight = false;
    const READ = buildReadJs(INSTALL_FOCUS_HOOK);
    const tick = async () => {
      // Skip if the previous eval hasn't resolved — on a hung page browser_eval_js
      // can take up to its 8s timeout, and ungated ticks would pile up blocked
      // spawn_blocking workers behind it.
      if (stop || inFlight || !docVisible()) return;
      inFlight = true;
      try {
        const s = parsePageState(await tauriInvoke<string>('browser_eval_js', { id, js: READ }));
        if (stop || !s) return;
        // PRECEDENZA. Se il drain nativo ha consegnato di recente, url/title/
        // loading sono suoi e questo tick NON li tocca: l'eval legge il documento
        // COMMITTATO, che su una pagina lenta è ancora quello di prima, e
        // riscriverlo qui farebbe tornare la barra all'indirizzo precedente. Il
        // resto del tick vale comunque, ed è il motivo per cui il poll non si
        // spegne: favicon, zoom, contatore di fuoco e console non passano da KVO.
        if (!nativeNavIsFresh(nativeNavAtRef.current, Date.now())) {
          if (s.url) setUrl(s.url);
          setTitle(s.title);
          setLoading(isPageLoading(s.readyState));
        }
        if (s.favicon) setFaviconUrl(s.favicon);
        reassertZoom(s.zoomStyle);
        // A growing pointerdown counter means the user clicked inside this native
        // pane — activate its tab (the click never reached React otherwise). First
        // read just baselines; the in-page hook only counts trusted+focused
        // clicks; and a bump seen inside the post-reflow suppression window is
        // re-baselined, never fired (a move/thaw drew the event, not the user).
        maybeFireSelfFocus(s.focusBump);
        // Drain any console entries buffered by the injected proxy (CONSOLE_PROXY_JS).
        if (s.console.length) {
          setConsoleEntries((prev) => {
            const add = s.console.map((e) => ({ id: ++consoleIdRef.current, level: e.level, text: e.text }));
            const next = prev.concat(add);
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
        }
      } catch {
        /* pane closing / eval timeout — ignore, next tick retries */
      } finally {
        inFlight = false;
      }
    };
    const iv = window.setInterval(tick, 800);
    const offVis = onDocumentVisible(() => { void tick(); }); // catch up on re-show
    void tick(); // prime immediately
    return () => {
      stop = true;
      offVis();
      window.clearInterval(iv);
    };
  }, [id, ready, isVisible, maybeFireSelfFocus, reassertZoom]);

  // Background tab title/url/favicon. The fast poll above is gated on isVisible, so
  // a browser pane opened/navigated while it's NOT the foreground tab (agent-opened,
  // or any non-active tab) would never fetch its <title> and the tab would stay
  // label-less. Run a SLOW (2.5s), cheap title/url/favicon read while hidden so its
  // tab still converges to a real label; foreground panes are covered by the fast
  // poll (this effect is off then — the two gates are complementary). No console
  // drain / focus bump here (those only matter for the visible pane).
  //
  // It DOES carry readyState and zoom (see browserPagePoll — both polls are built
  // from the same fields). A background pane hasn't stopped navigating: it was the
  // only poll that could clear `loading` for a pane sent to the background
  // mid-load, and without the field it couldn't — the tab's spinner turned for the
  // rest of the session and `useReportBrowserActivity` kept reporting the pane as
  // busy into the project rollup.
  useEffect(() => {
    if (!ready || isVisible) return;
    let stop = false;
    let inFlight = false;
    const tick = async () => {
      if (stop || inFlight || !docVisible()) return;
      inFlight = true;
      try {
        const s = parsePageState(await tauriInvoke<string>('browser_eval_js', { id, js: META_JS }));
        if (stop || !s) return;
        // Stessa precedenza del poll in primo piano: il nativo, se ha parlato di
        // recente, è la verità. Vale anche qui perché il drain non è gated su
        // `isVisible`, quindi una pane di sfondo ha davvero due sorgenti.
        if (!nativeNavIsFresh(nativeNavAtRef.current, Date.now())) {
          if (s.url) setUrl(s.url);
          if (s.title) setTitle(s.title);
          setLoading(isPageLoading(s.readyState));
        }
        if (s.favicon) setFaviconUrl(s.favicon);
        reassertZoom(s.zoomStyle);
      } catch { /* pane closing / eval timeout — next tick retries */ }
      finally { inFlight = false; }
    };
    void tick(); // prime once immediately so the label appears fast on open
    const iv = window.setInterval(tick, 2500);
    const offVis = onDocumentVisible(() => { void tick(); });
    return () => { stop = true; offVis(); window.clearInterval(iv); };
  }, [id, ready, isVisible, reassertZoom]);

  // ── Stato nav dai NATIVI (KVO su URL/title/loading) ───────────────────────
  //
  // Fin qui l'indirizzo, il titolo e la barra di caricamento li leggeva un eval
  // in pagina, a 800ms sulla pane visibile e 2500ms su quella di sfondo. Un poll
  // si VEDE: clicchi un link e la barra resta sull'indirizzo di prima per
  // mezzo secondo. Adesso WebKit lo dice da sé via KVO e il Rust lo mette in
  // coda; questo drain la svuota a 250ms.
  //
  // NON è gated su `isVisible`, come il drain degli errori di navigazione qui
  // sotto: una pane di sfondo naviga (un agente la guida, un redirect arriva) e
  // la sua tab deve convergere sull'etichetta giusta. Costa un mutex vuoto per
  // tick, non un eval in un altro processo.
  //
  // Il poll eval RESTA: fuori da macOS la coda è vuota per contratto, quindi lì
  // è l'unica sorgente e deve bastare da sola. La precedenza quando ci sono
  // entrambe sta in `nativeNavIsFresh` (una finestra di fiducia, non un
  // interruttore) ed è applicata dentro i due poll.
  const nativeNavAtRef = useRef(0);
  /** Quando la strip d'errore ha spento la barra per un fallimento noto. */
  const navFailedAtRef = useRef(0);

  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const iv = window.setInterval(() => {
      void tauriInvoke<Array<{ url: string; title: string; loading: boolean }>>(
        'browser_take_nav_state',
        { id },
      )
        .then((events) => {
          if (stop) return;
          const s = pickNavState(events);
          if (!s) return; // coda vuota (o guscio senza il comando): niente da applicare
          nativeNavAtRef.current = Date.now();
          if (s.url) setUrl(s.url);
          // Un titolo VUOTO non si scrive: WebKit lo azzera all'inizio di ogni
          // navigazione, e scriverlo qui farebbe perdere l'etichetta alla tab a
          // ogni click. Quando la pagina nuova davvero non ha un <title>, a
          // ripulirlo pensa il poll eval appena la fiducia scade: lì `setTitle`
          // è senza guardia.
          if (s.title) setTitle(s.title);
          // Un fallimento noto batte tutto (vedi `setLoading(false)` nel drain
          // degli errori): se la strip ha appena spento la barra, un
          // `loading: true` che arriva dietro di lui non la riaccende.
          if (!(s.loading && Date.now() - navFailedAtRef.current < NAV_FAIL_GRACE_MS)) {
            setLoading(s.loading);
          }
        })
        .catch(() => {});
    }, 250);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [id, ready]);

  // Navigation failures — drain the Rust did-fail queue (browser_take_nav_errors,
  // scoped to this pane, same contract as the download queue). A pure mutex
  // drain, NO page eval — so it works exactly when the eval polls can't: a page
  // that never loaded, a hung host, a dead DNS name. Not gated on visibility
  // (agent-driven navigations fail in background tabs too); ~zero cost per tick.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const iv = window.setInterval(() => {
      void tauriInvoke<Array<{ url: string; description: string; code: number }>>(
        'browser_take_nav_errors',
        { id },
      )
        .then((events) => {
          if (stop || !events || events.length === 0) return;
          const last = events[events.length - 1];
          // La traduzione sta in `navErrorMessage`: qui arriva la stringa di
          // Cocoa, che per il caso più comune di questo pannello (una scheda che
          // riapre su una porta locale ormai spenta) è «Could not connect to the
          // server.» — muta su quale server, su cosa manca e sul fatto che
          // «Riprova» non può bastare.
          setNavError({ ...navErrorMessage(last), url: last.url });
          // A known failure outranks whatever the last tick read — eval poll AND
          // native drain. Il timestamp è come lo dice al drain dello stato nav,
          // che gira quattro volte più spesso di questo (vedi NAV_FAIL_GRACE_MS).
          navFailedAtRef.current = Date.now();
          setLoading(false);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [id, ready]);

  // #3 instant focus-on-click. The 800ms data poll above ALSO detects clicks
  // into the native pane (the pointerdown bump → activate the tab), but at up to
  // 800ms latency the tab activates visibly late. A native WKWebView composites
  // ABOVE the React DOM, so the click never reaches React — polling the injected
  // counter is the only pull signal. Run a dedicated, lightweight poll (bump
  // counter ONLY — a trivial eval) at ~120ms so the tab activates near-instantly.
  // Shares __topicsFocusBump + lastFocusBumpRef with the data poll: whichever
  // observes the increment first fires onFocused; the other sees no change (the
  // compare+set is synchronous, no await between, so no double-fire).
  //
  // PORTA ANCHE IL TASTO DESTRO, e non per comodità: il menu contestuale deve
  // comparire alla cadenza del gesto, e questo è l'unico poll che gira a 120ms.
  // Il payload diventa un JSON con due campi invece di un numero; l'eval è lo
  // stesso, quindi non c'è nessun giro di IPC in più. L'installazione dell'hook
  // sta qui dentro per la stessa ragione per cui ci sta `INSTALL_FOCUS_HOOK`:
  // ogni navigazione rimpiazza il documento e con lui la guardia, e un eval che
  // gira sempre è ciò che lo reinstalla senza che nessuno debba accorgersi della
  // navigazione. Il gate su `isVisible` è corretto: una pane che non si vede non
  // si può nemmeno cliccare col destro.
  useEffect(() => {
    if (!ready || !isVisible) return;
    let stop = false;
    let inFlight = false;
    const FAST =
      "(function(){" + INSTALL_FOCUS_HOOK + PANE_CONTEXT_HOOK_JS +
      "try{return JSON.stringify({k:window.__topicsFocusBump||0,m:" + PANE_CONTEXT_TAKE_EXPR + "})}" +
      "catch(e){return ''}})()";
    const tick = async () => {
      if (stop || inFlight || !docVisible()) return;
      inFlight = true;
      try {
        const raw = await tauriInvoke<string>('browser_eval_js', { id, js: FAST });
        if (stop || !raw) return;
        let payload: { k?: unknown; m?: unknown } | null = null;
        try { payload = JSON.parse(raw) as { k?: unknown; m?: unknown }; } catch { return; }
        if (!payload) return;
        maybeFireSelfFocus(typeof payload.k === 'number' ? payload.k : 0);
        const req = parsePaneContextRequest(payload.m);
        if (req) {
          // Il punto arriva in coordinate della PAGINA. Lo slot VIVO dal DOM (la
          // stessa fonte con cui si decide l'occlusione), lo zoom e le dimensioni
          // dell'emulazione lo portano nelle coordinate della finestra, dove il
          // menu vive.
          setPaneContext(paneToHostPoint(req, liveSlotRect(id) ?? pendingRectRef.current, {
            zoomPercent: zoomRef.current,
            deviceDims: deviceDimsRef.current,
          }));
        }
      } catch { /* pane closing / eval timeout — next tick retries */ }
      finally { inFlight = false; }
    };
    // 8.3 evals/s per visible pane is the price of instant tab activation while
    // you are looking at the app; while it is occluded it buys nothing, and the
    // bump counter is monotonic so the catch-up tick loses no click.
    const iv = window.setInterval(tick, 120);
    const offVis = onDocumentVisible(() => { void tick(); });
    return () => { stop = true; offVis(); window.clearInterval(iv); };
  }, [id, ready, isVisible, maybeFireSelfFocus]);

  const toggleDevTools = useCallback(async () => {
    await tauriInvoke('browser_toggle_devtools', { id }).catch(() => {});
  }, [id]);

  // ── Le tre letture che servono al menu contestuale ────────────────────────
  const clearPaneContext = useCallback(() => setPaneContext(null), []);

  /** La selezione INTERA. `paneContext.selection` è tagliata a 200 caratteri per
   *  non far viaggiare mezza pagina dentro un poll che gira a 120ms; qui si paga
   *  un eval solo quando l'utente sceglie «Copia». La pane è congelata mentre il
   *  menu è aperto, ma congelare parcheggia la VISTA: il documento resta vivo e
   *  la sua selezione con lui. */
  const readSelection = useCallback(async (): Promise<string> => {
    try {
      return (await tauriInvoke<string>('browser_eval_js', { id, js: PANE_SELECTION_JS })) || '';
    } catch {
      return '';
    }
  }, [id]);

  /**
   * I byte di un'immagine della pagina, come data URL PNG.
   *
   * L'estrazione è asincrona (l'immagine si ricarica dentro la pagina con
   * `crossOrigin`) mentre `browser_eval_js` risponde subito: quindi si avvia e
   * poi si aspetta il globale, come fa il picker dell'elemento con
   * `__topicsPick`. Il tetto è 3 secondi, dopo i quali si torna null e chi ha
   * chiesto la copia lo dice: senza CORS il canvas resta contaminato e nessuna
   * attesa più lunga cambierebbe l'esito.
   */
  const readImageDataUrl = useCallback(async (src: string): Promise<string | null> => {
    if (!src) return null;
    const started = await tauriInvoke('browser_exec_js', { id, js: imageCopyStartJs(src) })
      .then(() => true, () => false);
    if (!started) return null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const raw = await tauriInvoke<string>('browser_eval_js', { id, js: IMAGE_COPY_READ_JS })
        .catch(() => '');
      if (raw === 'ERR') return null;
      if (raw && raw.startsWith('data:image/')) return raw;
    }
    return null;
  }, [id]);

  // Select-element: inspect the DOM node at page coords (document.elementFromPoint)
  // and return a css/dom path + bbox + text — the data the chat reference needs.
  const inspectAt = useCallback(
    async (x: number, y: number) => {
      const js =
        `(function(x,y){try{var el=document.elementFromPoint(x,y);if(!el)return null;` +
        `function cp(e){var p=[],n=0;while(e&&e.nodeType===1&&n++<8){var s=e.tagName.toLowerCase();` +
        `if(e.id){p.unshift(s+'#'+e.id);break}var c=e.className&&e.className.toString().trim().split(/\\s+/)[0];if(c)s+='.'+c;` +
        `var par=e.parentNode;if(par){var sib=Array.prototype.filter.call(par.children,function(z){return z.tagName===e.tagName});` +
        `if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(e)+1)+')'}p.unshift(s);e=e.parentNode}return p.join(' > ')}` +
        `function dp(e){var p=[];while(e&&e.nodeType===1){p.unshift(e.tagName.toLowerCase());e=e.parentNode}return p.join('/')}` +
        `var r=el.getBoundingClientRect();var t=(el.innerText||el.textContent||'').trim().slice(0,120);` +
        `return JSON.stringify({cssPath:cp(el),domPath:dp(el),bbox:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},text:t})}catch(e){return null}})(${Math.round(x)},${Math.round(y)})`;
      try {
        const raw = await tauriInvoke<string>('browser_eval_js', { id, js });
        if (!raw || raw === 'null') return null;
        return JSON.parse(raw) as { cssPath: string; domPath: string; bbox: { x: number; y: number; w: number; h: number }; text: string };
      } catch {
        return null;
      }
    },
    [id],
  );

  // ── Select-element (Cmd+Shift+E) ──────────────────────────────────────────
  // The native pane composites ABOVE the DOM, so a React overlay can't catch a
  // click on it. Instead inject an in-PAGE picker (hover outline + banner +
  // capturing click/Esc) and poll `window.__topicsPick` for the result, then
  // dispatch `chat:insert-text` — the same protocol the streaming/Electron
  // overlays use, so the chat input picks it up identically.
  //
  // 4.2: la RACCOLTA non è più scritta a mano qui. Il picker inietta la stessa
  // `DESCRIBE_ELEMENT_FN` che il server valuta con Playwright, così il blocco
  // che arriva in chat è identico nelle due pane. Al click segue uno snapshot
  // della view, ritagliato sul riquadro (`cropToElement`) e allegato come
  // immagine: è la parte che la WKWebView non sa fare da sola.
  const exitSelectMode = useCallback(() => {
    if (selectPollRef.current) { clearInterval(selectPollRef.current); selectPollRef.current = null; }
    setSelectMode(false);
    void tauriInvoke('browser_exec_js', {
      id,
      js: 'try{window.__topicsSelCleanup&&window.__topicsSelCleanup()}catch(e){}',
    }).catch(() => {});
  }, [id]);

  const enterSelectMode = useCallback(() => {
    setSelectMode(true);
    const inject =
      `(function(){if(window.__topicsSelMode)return;window.__topicsSelMode=true;window.__topicsPick=null;` +
      `var ov=document.createElement('div');ov.style.cssText='position:fixed;z-index:2147483647;border:2px solid #06f;background:rgba(0,102,255,.12);pointer-events:none;transition:all .04s';` +
      `var bn=document.createElement('div');bn.textContent='Click per selezionare un elemento · Esc per annullare';bn.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#06f;color:#fff;font:12px -apple-system,sans-serif;padding:4px 12px;border-radius:99px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)';` +
      `document.documentElement.appendChild(ov);document.documentElement.appendChild(bn);` +
      `var describe=${DESCRIBE_ELEMENT_FN.toString()};` +
      `function at(x,y){return document.elementFromPoint(x,y)}` +
      `function mm(e){var el=at(e.clientX,e.clientY);if(!el||el===ov||el===bn)return;var r=el.getBoundingClientRect();ov.style.left=r.left+'px';ov.style.top=r.top+'px';ov.style.width=r.width+'px';ov.style.height=r.height+'px'}` +
      // La descrizione si prende DENTRO il click: dopo `cl()` il riquadro non
      // c'è più e lo stato :hover è già decaduto.
      `function ck(e){e.preventDefault();e.stopPropagation();var d=null;try{d=describe({x:e.clientX,y:e.clientY})}catch(err){d=null}window.__topicsPick=d?JSON.stringify(d):'CANCEL';cl()}` +
      `function ke(e){if(e.key==='Escape'){window.__topicsPick='CANCEL';cl()}}` +
      `function cl(){window.__topicsSelMode=false;document.removeEventListener('mousemove',mm,true);document.removeEventListener('click',ck,true);document.removeEventListener('keydown',ke,true);try{ov.remove();bn.remove()}catch(e){}window.__topicsSelCleanup=null}` +
      `window.__topicsSelCleanup=cl;document.addEventListener('mousemove',mm,true);document.addEventListener('click',ck,true);document.addEventListener('keydown',ke,true)})()`;
    void tauriInvoke('browser_exec_js', { id, js: inject }).catch(() => {});
    if (selectPollRef.current) clearInterval(selectPollRef.current);
    selectPollRef.current = setInterval(() => {
      void tauriInvoke<string>('browser_eval_js', {
        id,
        js: '(function(){var p=window.__topicsPick;if(p)window.__topicsPick=null;return p||""})()',
      })
        .then((raw) => {
          if (!raw) return;
          // stop polling regardless of pick vs cancel
          if (selectPollRef.current) { clearInterval(selectPollRef.current); selectPollRef.current = null; }
          setSelectMode(false);
          if (raw === 'CANCEL') return;
          let info: ElementDescription;
          try {
            info = JSON.parse(raw) as ElementDescription;
          } catch {
            return; // pick malformato: meglio niente che un blocco a metà
          }
          void (async () => {
            // Lo snapshot arriva DOPO il pick: il picker si è già smontato,
            // quindi il riquadro blu non finisce dentro il ritaglio.
            let crop: { dataUrl: string; w: number; h: number } | null = null;
            try {
              const shot = await tauriInvoke<string>('browser_screenshot', { id });
              if (shot) {
                crop = await cropToElement(
                  `data:image/png;base64,${shot}`,
                  info.bbox,
                  info.viewport,
                );
              }
            } catch { /* niente ritaglio: il blocco di testo vale comunque */ }
            window.dispatchEvent(
              new CustomEvent('chat:insert-text', {
                detail: { text: formatElementContext(info, { screenshotAttached: !!crop }) },
              }),
            );
            if (crop) {
              window.dispatchEvent(
                new CustomEvent('chat:attach-image', {
                  detail: {
                    dataUrl: crop.dataUrl,
                    mimeType: crop.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
                  },
                }),
              );
            }
          })();
        })
        .catch(() => {});
    }, 150);
  }, [id]);

  // Tear down the select poll if the pane unmounts mid-pick.
  useEffect(() => () => { if (selectPollRef.current) clearInterval(selectPollRef.current); }, []);

  // /ws/browser/:contextId — two jobs over the one socket the Electron + streaming
  // paths also use (server already serves it; no server change for the pill):
  //  • agent_active broadcast → the toolbar pill, AND
  //  • NATIVE-PANE AGENT DELEGATION: register this pane as the executor for its
  //    contextId, then run each delegated `browser_op` against the real WKWebView
  //    via the native browser_* commands and reply — so a server-side agent can
  //    drive the native pane (the ops that map; the rest get a streaming-mode hint).
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    const openHandler = () => {
      try { ws?.send(JSON.stringify({ type: 'register_native_executor' })); } catch { /* ignore */ }
    };
    const messageHandler = (e: MessageEvent) => {
      let raw: unknown;
      try { raw = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
      const m = raw as { type?: string; opId?: string; tool?: string; args?: unknown; active?: boolean; action?: string };
      if (m && m.type === 'browser_op' && typeof m.opId === 'string' && typeof m.tool === 'string') {
        // A background pane is hidden (see setNativeVisible), and a hidden NSView
        // can't be snapshotted or laid out — so wake it for the duration of the
        // op. It stays parked off-screen throughout, so nothing appears to the
        // user. The settle gives WebKit a beat to paint the newly-unhidden view
        // before a screenshot op reads it, which would otherwise come back blank.
        agentOpsInFlightRef.current += 1;
        void setNativeVisible(true)
          .then(async (woke) => {
            if (woke) await new Promise((r) => setTimeout(r, 150));
            return executeNativeBrowserOp(id, m.tool!, m.args, tauriInvoke);
          })
          .then((out) => {
            if (closed) return;
            try { ws?.send(JSON.stringify({ type: 'browser_op_result', opId: m.opId, ...out })); } catch { /* ignore */ }
          })
          .finally(() => {
            agentOpsInFlightRef.current -= 1;
            // Last op out re-hides, unless the pane became genuinely visible or
            // the agent formally attached in the meantime.
            if (agentOpsInFlightRef.current === 0 && !isVisibleRef.current && !agentActiveRef.current) {
              void setNativeVisible(false);
            }
          });
        return;
      }
      const result = parseBrowserWsMessage(raw);
      if (!result.ok || result.data.type !== 'agent_active') return;
      setAgentActive(Boolean(result.data.active));
      if (result.data.active && result.data.action) setAgentAction(result.data.action);
    };
    try {
      ws = new WebSocket(`${serverWsBase()}/ws/browser/${encodeURIComponent(id)}`);
      ws.addEventListener('open', openHandler);
      ws.addEventListener('message', messageHandler);
    } catch { /* ws construction failed — pill stays off, no delegation */ }
    return () => {
      closed = true;
      if (ws) {
        ws.removeEventListener('open', openHandler);
        ws.removeEventListener('message', messageHandler);
        try { ws.close(); } catch { /* ignore */ }
      }
    };
    // setNativeVisible is useCallback([id]), so it never re-opens the socket on
    // its own — isVisible/agentActive are read through refs for that reason.
  }, [id, setNativeVisible]);

  // Zoom via injected CSS (WKWebView has no JS zoom API; document zoom is the
  // portable stop-gap). The percentage is snapped to a fixed Chrome-style ladder
  // (see zoomScale) so every step is a clean round integer — only the SIGN of
  // `delta` matters, so buttons (±1) and keyboard (±0.5) both move one notch.
  const setZoom = useCallback(
    async (delta: number | 'reset'): Promise<number> => {
      const next = delta === 'reset' ? DEFAULT_ZOOM : stepZoom(zoomRef.current, delta);
      zoomRef.current = next;
      setZoomState(next);
      await tauriInvoke('browser_exec_js', { id, js: zoomApplyJs(next) }).catch(() => {});
      return next;
    },
    [id],
  );

  // Find-in-page via WebKit's window.find (highlights + scrolls to the match).
  // Firma reale: window.find(testo, maiuscoleContano, indietro, avvolgi).
  // `matchCase` era inchiodato a `false` mentre l'interfaccia lo dichiarava
  // (browserDevTypes): la barra poteva chiedere la ricerca esatta e riceveva
  // sempre quella insensibile, senza niente a dirlo. Il quarto argomento resta
  // `true` (avvolgi) ed è il ciclo che `stepMatchIndex` rispecchia lato client.
  const findInPage = useCallback(
    async (text: string, opts?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }) => {
      const fwd = opts?.forward !== false;
      await tauriInvoke('browser_exec_js', {
        id,
        js: `try{window.find(${JSON.stringify(text)},${opts?.matchCase === true},${!fwd},true)}catch(e){}`,
      }).catch(() => {});
    },
    [id],
  );
  const stopFind = useCallback(async () => {
    await tauriInvoke('browser_exec_js', { id, js: 'try{getSelection().removeAllRanges()}catch(e){}' }).catch(() => {});
  }, [id]);

  // window.find gives no count, so count occurrences in the page text ourselves
  // (browser_eval_js returns the number stringified). Il conteggio DEVE seguire
  // lo stesso `matchCase` della ricerca: con la ricerca esatta accesa e il conto
  // insensibile, «3/12» diceva un totale che WebKit non avrebbe mai raggiunto e
  // il ciclo tornava a 1 in anticipo.
  const countMatches = useCallback(async (text: string, opts?: { matchCase?: boolean }): Promise<number> => {
    if (!text) return 0;
    const js =
      `(function(q,cs){try{var t=(document.body&&document.body.innerText)||'';if(!t||!q)return 0;` +
      `var h=cs?t:t.toLowerCase(),n2=cs?q:q.toLowerCase(),n=0,i=0;if(!n2)return 0;` +
      `while((i=h.indexOf(n2,i))!==-1){n++;i+=n2.length}return n}catch(e){return 0}})(` +
      `${JSON.stringify(text)},${opts?.matchCase === true})`;
    try {
      const raw = await tauriInvoke<string>('browser_eval_js', { id, js });
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }, [id]);

  const clearConsole = useCallback(() => {
    setConsoleEntries([]);
    void tauriInvoke('browser_exec_js', { id, js: 'try{window.__topicsConsole&&(window.__topicsConsole.length=0)}catch(e){}' }).catch(() => {});
  }, [id]);

  const consoleSummary = useMemo(() => ({
    errors: consoleEntries.reduce((n, e) => (e.level === 'error' ? n + 1 : n), 0),
    warnings: consoleEntries.reduce((n, e) => (e.level === 'warn' ? n + 1 : n), 0),
  }), [consoleEntries]);

  // Device emulation: pick the preset's dims + UA, letterbox the pane to them and
  // reload so the custom UA takes effect (WKWebView applies it on next load). The
  // UA override also flips navigator.userAgent, so emulation is real, not just a
  // resize. desktop/auto reset both.
  //
  // The reload is why the zoom kept vanishing whenever anyone touched this
  // control: it hands the pane a new document, and a document doesn't inherit an
  // inline zoom. The polls now put it back (see `reassertZoom`), so switching
  // device no longer silently drops the user back to 100% while the toolbar
  // insists otherwise.
  const setDevice = useCallback(
    (mode: DeviceMode, custom?: { width: number; height: number }) => {
      setDeviceMode(mode);
      let dims: { width: number; height: number } | null = null;
      let ua = '';
      if (mode === 'mobile' || mode === 'tablet') {
        const p = DEVICE_PRESETS[mode];
        if (p.width && p.height) dims = { width: p.width, height: p.height };
        ua = p.userAgent ?? '';
      } else if (mode === 'custom' && custom) {
        dims = { width: Math.round(custom.width), height: Math.round(custom.height) };
      }
      deviceDimsRef.current = dims;
      setResponsiveSizeState(mode === 'custom' ? dims : null);
      void paneInvoke('browser_set_user_agent', { id, ua })
        .then((ok) => { if (ok) void paneInvoke('browser_reload', { id }); });
      // A no-op whenever the preset was picked from the switcher's MENU — a menu
      // is an overlay, an overlay over this pane means the pane is frozen, and
      // applyBounds refuses to move a frozen view. Kept for the paths that
      // aren't a menu (an agent, a shortcut); `thaw()` applies the letterbox
      // when the menu closes.
      applyBounds();
    },
    [id, applyBounds, paneInvoke],
  );

  /**
   * Read the device mode back off the page instead of assuming it.
   *
   * `deviceMode` is component state and the webview is not: `browser_open` reuses
   * a live view, a background tab stays mounted, a ⌘R of the host UI doesn't tear
   * the child webview down at all. Every one of those put the switcher back to
   * Desktop over a view still serving an iPhone User-Agent — the menu claiming
   * one thing and the site seeing another, with nothing on screen to say which.
   * One cheap eval when the view becomes ready settles it from the only authority
   * there is (see deviceModeFromUserAgent).
   */
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    // `browser_eval_js` stringifies through `[obj description]`, which for an
    // NSString IS the string — the UA arrives raw, unquoted.
    void tauriInvoke<string>('browser_eval_js', { id, js: 'navigator.userAgent' })
      .then((ua) => {
        if (stop || !ua) return;
        const mode = deviceModeFromUserAgent(ua);
        const prev = deviceModeRef.current;
        // Only reconcile a DISAGREEMENT about emulation, and never overwrite
        // `custom`: responsive resize sets no UA, so the page cannot report it
        // and would read as `desktop` here.
        if (prev === mode || prev === 'custom' || prev === 'auto') return;
        const p = mode === 'desktop' ? null : DEVICE_PRESETS[mode];
        deviceDimsRef.current = p?.width && p.height ? { width: p.width, height: p.height } : null;
        setDeviceMode(mode);
        applyBounds(); // the letterbox has to match what we just discovered
      })
      .catch(() => {});
    return () => { stop = true; };
  }, [id, ready, applyBounds]);

  const setResponsiveSize = useCallback(
    (width: number, height: number) => {
      const dims = { width: Math.round(width), height: Math.round(height) };
      deviceDimsRef.current = dims;
      setResponsiveSizeState(dims);
      setDeviceMode('custom');
      applyBounds();
    },
    [applyBounds],
  );

  // Real WKBackForwardList (Rust browser_nav_entries) → the toolbar's
  // back/forward history dropdown. The client adds the 0-based `index`.
  const getNavEntries = useCallback(async () => {
    try {
      const raw = await tauriInvoke<string>('browser_nav_entries', { id });
      const parsed = JSON.parse(raw || '{}') as {
        entries?: { url: string; title: string }[];
        activeIndex?: number;
      };
      const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map((e, index) => ({
        url: e.url,
        title: e.title,
        index,
      }));
      return { entries, activeIndex: typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0 };
    } catch {
      return { entries: [], activeIndex: 0 };
    }
  }, [id]);

  const goToNavIndex = useCallback(async (index: number) => {
    await paneInvoke('browser_go_to_index', { id, index });
  }, [id, paneInvoke]);

  /**
   * Throw this pane's webview away and build a new one at the same address.
   *
   * The recovery `no_abort`'s doc comment already promised ("the pane self-heal
   * path can recreate the webview") and that nothing on this side implemented.
   * A poisoned dispatcher mutex is permanent for the view that owns it, so
   * retrying the same command is pointless and only a fresh view can help.
   *
   * Closes DIRECTLY rather than through the deferred-close grace: that grace
   * exists to survive React remount churn, and here we want the old view gone
   * before the new one is asked for.
   *
   * L'ESITO DELLA CHIUSURA SI LEGGE. Col mutex avvelenato la vista non muore —
   * `Webview::close()` passa dallo stesso lock di tutto il resto — e resta
   * registrata nel manager: riaprire sullo stesso id cadeva nel ramo di RIUSO di
   * `browser_open`, che riconsegnava la stessa vista morta. Il pulsante non
   * ricreava niente proprio nel caso per cui esiste. Adesso il guscio se ne
   * accorge (`browser_close` torna Err) e BRUCIA l'etichetta, quindi la
   * riapertura che segue nasce comunque come vista nuova; qui si legge il
   * fallimento per dirlo nel log invece di fingere che sia andata bene.
   *
   * E IL GUASTO NON SI AZZERA A MANO. Azzerarlo qui faceva sparire la striscia
   * all'istante e ricomparire dopo altri tre fallimenti: l'utente vedeva
   * «risolto» per un attimo, poi il guasto tornava. Lo cancella la vista NUOVA
   * rispondendo a un comando strutturale (`recordPaneOk` su `browser_set_bounds`
   * in `applyBounds`), che è l'unica prova che qualcosa è cambiato davvero.
   */
  const recreate = useCallback(async () => {
    setLoading(true);
    await recreatePane({
      close: () => tauriInvoke('browser_close', { id }).then(() => true, () => false),
      open: () => requestOpenView(urlRef.current || initialUrlRef.current || 'about:blank'),
      // La stretta di mano è un `browser_set_bounds` sulla vista appena nata: se
      // risponde, il guasto cade da sé (`recordPaneOk` dentro `paneInvoke`); se
      // non risponde, la striscia resta — che è la verità. `applyOpened` lo fa
      // già quando c'è un rect misurato, questo copre la ricreazione che arriva
      // prima di ogni misura.
      handshake: applyBounds,
      onLabelBurned: () =>
        console.warn(`[tauri-browser] pane ${id}: la vista ha rifiutato di chiudersi — etichetta bruciata, riapro come vista nuova`),
    });
  }, [id, applyBounds, requestOpenView]);

  // Derive the arrows' enabled state from the real WKBackForwardList. Event-
  // driven (runs when a load settles, not per poll-tick): activeIndex>0 means
  // there's history behind, activeIndex<last means there's history ahead.
  const refreshNavState = useCallback(async () => {
    const { entries, activeIndex } = await getNavEntries();
    setCanGoBack(activeIndex > 0);
    setCanGoForward(activeIndex < entries.length - 1);
  }, [getNavEntries]);

  useEffect(() => {
    if (ready && !loading) void refreshNavState();
  }, [ready, loading, refreshNavState]);

  const viewId = ready ? id : null;

  // Memoized: this hook re-renders often (the 120ms fast-focus poll alone can
  // tick every frame), and a fresh object identity every render defeated
  // downstream `useEffect([browser])` deps (e.g. RemoteBrowserPanel's keydown
  // handler), forcing them to re-subscribe constantly. Mirrors useRemoteBrowser's
  // sibling useMemo. Every value below is either a primitive/derived-primitive
  // or a useCallback stable on the deps listed here, so the memo only produces
  // a new object when something a consumer could actually observe changed.
  return useMemo<NativeBrowserHandle>(() => ({
    url,
    title,
    loading,
    agentActive,
    agentAction,
    ready,
    viewId,
    faviconUrl,
    frozenImage,
    navError,
    clearNavError,
    retryNav,
    parked,
    parkedChecking,
    retryParked,
    navigate,
    goBack,
    goForward,
    reload,
    goHome,
    setBounds,
    animateBounds,
    toggleDevTools,
    findInPage,
    stopFind,
    setZoom,
    zoom,
    countMatches,
    inspectAt,
    paneContext,
    clearPaneContext,
    readSelection,
    readImageDataUrl,
    selectMode,
    enterSelectMode,
    exitSelectMode,
    deviceMode,
    setDevice,
    responsiveSize,
    setResponsiveSize,
    consoleEntries,
    consoleSummary,
    clearConsole,
    getNavEntries,
    goToNavIndex,
    nativeFault: fault.faulted ? { command: fault.command ?? 'un comando nativo' } : null,
    recreate,
    canGoBack,
    canGoForward,
  }), [
    url, title, loading, agentActive, agentAction, ready, viewId, faviconUrl, frozenImage,
    navError, clearNavError, retryNav, parked, parkedChecking, retryParked,
    navigate, goBack, goForward, reload, goHome, setBounds, animateBounds, toggleDevTools, findInPage, stopFind,
    setZoom, zoom, countMatches, inspectAt, paneContext, clearPaneContext, readSelection,
    readImageDataUrl, selectMode, enterSelectMode, exitSelectMode,
    deviceMode, setDevice, responsiveSize, setResponsiveSize, consoleEntries, consoleSummary,
    clearConsole, getNavEntries, goToNavIndex, fault, recreate, canGoBack, canGoForward,
  ]);
}
