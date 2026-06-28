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
 * Capabilities not yet wired (return inert stubs): DevTools, find-in-page, zoom,
 * device emulation, console capture, nav-history menu, agent CDP. Navigation +
 * geometry + show/hide (the "solido" core) are live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { tauriInvoke } from '../lib/shell/tauri';
import { slotIsOccluded, onOcclusionChange } from '../lib/shell/browserOcclusion';
import { serverWsBase } from '../lib/shell/net';
import { executeNativeBrowserOp } from '../lib/shell/tauriBrowserOps';
import { parseBrowserWsMessage } from '../types/browser-ws-messages';
import type { NativeBrowserHandle } from './useNativeBrowser';
import type { DeviceMode, BrowserConsoleEntry } from '@/components/Browser/browserDevTypes';
import { DEVICE_PRESETS } from '@/components/Browser/browserDevTypes';

/** Parking spot far outside any display — keeps the webview alive (no reload)
 *  while hidden, vs destroying it. Matches Electron's zero-bounds hide intent. */
const OFFSCREEN = { x: -100000, y: 0, width: 1, height: 1 } as const;

/** Best-effort URL/search normalisation for the address bar. Full URLs pass
 *  through; a bare host gets https://; anything else becomes a web search. */
function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  // looks like a domain (has a dot, no spaces) → https://
  if (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(' ')) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export function useTauriBrowser(contextId: string, initialUrl?: string): NativeBrowserHandle {
  const id = contextId;
  const [ready, setReady] = useState(false);
  const [url, setUrl] = useState(initialUrl ?? '');
  const [title, setTitle] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<BrowserConsoleEntry[]>([]);
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop');
  const [responsiveSize, setResponsiveSizeState] = useState<{ width: number; height: number } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [agentActive, setAgentActive] = useState(false);
  const [agentAction, setAgentAction] = useState<string | null>(null);
  const zoomRef = useRef(100); // page zoom percent (CSS-driven via exec_js)
  const consoleIdRef = useRef(0);
  const selectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Device emulation: when set, the pane is letterboxed to these dims inside its
  // layout slot (centered) + a device UA is applied. null = desktop (full slot).
  const deviceDimsRef = useRef<{ width: number; height: number } | null>(null);

  const openedRef = useRef(false);
  // Buffer the last requested SLOT rect (the layout cell), flushed once the
  // webview exists and re-used to recompute bounds on device-mode changes.
  const pendingRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
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
      rect = OFFSCREEN;
    }
    void tauriInvoke('browser_set_bounds', {
      id,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }).catch(() => {});
  }, [id]);

  const setBounds = useCallback(
    (b: { x: number; y: number; width: number; height: number }) => {
      if (b.width > 0 && b.height > 0) {
        pendingRectRef.current = b; // remember the real SLOT rect
        applyBounds(); // show (letterboxed if emulating; off-screen if occluded)
      } else if (openedRef.current) {
        // Explicit zero-rect = hide (drag/resize in flight, pane inactive, or an
        // HTML overlay over it — native views composite above the DOM). Park it,
        // keeping the stored slot so the next real rect restores it.
        void tauriInvoke('browser_set_bounds', { id, ...OFFSCREEN }).catch(() => {});
      }
    },
    [applyBounds, id],
  );

  // Capture a still, show it, then park the live view. Capturing FIRST (while the
  // view is on-screen) makes the swap seamless — the page never visibly vanishes.
  const freeze = useCallback(() => {
    if (!openedRef.current || frozenRef.current) return;
    frozenRef.current = true; // applyBounds is now a no-op — the poll can't fight us
    const seq = ++freezeSeqRef.current;
    if (thawTimerRef.current) { clearTimeout(thawTimerRef.current); thawTimerRef.current = null; }
    void tauriInvoke<string>('browser_screenshot', { id })
      .then((data) => {
        if (freezeSeqRef.current === seq && data) setFrozenImage(`data:image/png;base64,${data}`);
      })
      .catch(() => {})
      .finally(() => {
        // Park regardless (even if the shot failed, the overlay must show through);
        // skip if a thaw already superseded this freeze.
        if (freezeSeqRef.current === seq) void tauriInvoke('browser_set_bounds', { id, ...OFFSCREEN }).catch(() => {});
      });
  }, [id]);

  // Restore the live view at the real slot, then drop the still once the view is
  // surely back on top (it composites above the DOM, so an overlapping image
  // underneath is invisible — a generous delay is artifact-free).
  const thaw = useCallback(() => {
    if (!frozenRef.current) return;
    frozenRef.current = false;
    const seq = ++freezeSeqRef.current;
    window.dispatchEvent(new CustomEvent('browser:reflow-request'));
    if (thawTimerRef.current) clearTimeout(thawTimerRef.current);
    thawTimerRef.current = setTimeout(() => {
      if (freezeSeqRef.current === seq) setFrozenImage(null);
    }, 240);
  }, []);

  // Overlay occlusion: freeze ONLY while an overlay actually intersects THIS pane's
  // slot (a menu elsewhere leaves it untouched), so the still shows through and the
  // overlay renders over it; thaw when nothing covers it anymore. Replaces the old
  // global off-screen park, whose 30ms-debounce vs per-frame-poll race left a
  // visible 20-50ms vanish — and which hid every pane for any overlay anywhere.
  useEffect(() => {
    return onOcclusionChange(() => {
      if (!openedRef.current) return;
      const slot = pendingRectRef.current;
      if (slot && slotIsOccluded(slot)) freeze(); else thaw();
    });
  }, [freeze, thaw]);

  // NOTE: deliberately NO freeze-on-sidebar-animation. Hiding the live pane behind
  // a still just to survive the slide would be a kludge (same family as blanking
  // terminals during a resize). The structural fixes are: overlay-sidebar mode
  // (constant content width → the pane never moves) and disabling the WKWebView's
  // implicit Core Animation so the per-frame moves of PUSH mode are cheap (see
  // browser_open in src-tauri/src/lib.rs). Freeze stays scoped to its one
  // unavoidable case: an HTML overlay that must composite over the native view.

  // Drop a pending thaw timer on unmount.
  useEffect(() => () => { if (thawTimerRef.current) clearTimeout(thawTimerRef.current); }, []);

  // Create the native webview once per contextId; close on unmount. (Electron
  // keeps the view durable across unmount; for Tier-1 we close — simpler, and a
  // re-mount just re-opens. Revisit if tab-switch churn proves costly.)
  useEffect(() => {
    let cancelled = false;
    const startUrl = normalizeUrl(initialUrlRef.current ?? 'about:blank');
    void tauriInvoke('browser_open', { id, url: startUrl, x: -100000, y: 0, width: 800, height: 600 })
      .then(() => {
        if (cancelled) return;
        openedRef.current = true;
        setReady(true);
        setUrl(startUrl === 'about:blank' ? '' : startUrl);
        if (pendingRectRef.current) setBounds(pendingRectRef.current);
      })
      .catch((e) => console.warn('[tauri-browser] open failed', e));
    return () => {
      cancelled = true;
      openedRef.current = false;
      void tauriInvoke('browser_close', { id }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once per contextId; initialUrl is captured via ref so a persisted-url change never re-creates the view
  }, [id]);

  const navigate = useCallback(
    async (u: string) => {
      const norm = normalizeUrl(u);
      setUrl(norm === 'about:blank' ? '' : norm);
      setLoading(true);
      await tauriInvoke('browser_navigate', { id, url: norm }).catch(() => {});
      // WKWebView load events aren't bridged yet — clear the spinner heuristically.
      window.setTimeout(() => setLoading(false), 700);
    },
    [id],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    await tauriInvoke('browser_reload', { id }).catch(() => {});
  }, [id]);

  // Real WKWebView history nav (browser_back/forward) — not the old re-navigate
  // hack. The state poll below reflects the resulting url/title back into the UI.
  const goBack = useCallback(async () => {
    setLoading(true);
    await tauriInvoke('browser_back', { id }).catch(() => {});
  }, [id]);
  const goForward = useCallback(async () => {
    setLoading(true);
    await tauriInvoke('browser_forward', { id }).catch(() => {});
  }, [id]);
  const goHome = useCallback(async () => navigate(initialUrlRef.current ?? 'about:blank'), [navigate]);

  // ── Live state poll ──────────────────────────────────────────────────────
  // WKWebView's navigation-delegate load events aren't bridged, so a poll is the
  // robust way to keep the address bar, tab title and favicon in sync with what
  // the page actually does — IN-PAGE link clicks, redirects and SPA route
  // changes included (the old hook only updated `url` on explicit navigate(), so
  // clicking a link left the address bar stale). One cheap `browser_eval_js`
  // read per tick; `loading` is driven off the real document.readyState.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const READ =
      "JSON.stringify({u:location.href,t:document.title,r:document.readyState," +
      "f:(document.querySelector(\"link[rel~='icon']\")||{}).href||location.origin+'/favicon.ico'," +
      "c:(window.__topicsConsole?window.__topicsConsole.splice(0,window.__topicsConsole.length):[])})";
    const tick = async () => {
      if (stop) return;
      try {
        const raw = await tauriInvoke<string>('browser_eval_js', { id, js: READ });
        if (stop || !raw) return;
        const s = JSON.parse(raw) as {
          u: string; t: string; r: string; f: string;
          c?: { level: BrowserConsoleEntry['level']; text: string }[];
        };
        if (s.u && s.u !== 'about:blank') setUrl(s.u);
        setTitle(s.t || '');
        if (s.f) setFaviconUrl(s.f);
        setLoading(s.r !== 'complete');
        // Drain any console entries buffered by the injected proxy (CONSOLE_PROXY_JS).
        if (s.c && s.c.length) {
          setConsoleEntries((prev) => {
            const add = s.c!.map((e) => ({ id: ++consoleIdRef.current, level: e.level, text: e.text }));
            const next = prev.concat(add);
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
        }
      } catch {
        /* pane closing / eval timeout — ignore, next tick retries */
      }
    };
    const iv = window.setInterval(tick, 800);
    void tick(); // prime immediately
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [id, ready]);

  const noop = useCallback(async () => {}, []);

  const toggleDevTools = useCallback(async () => {
    await tauriInvoke('browser_toggle_devtools', { id }).catch(() => {});
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
      `function cp(e){var p=[],n=0;while(e&&e.nodeType===1&&n++<8){var s=e.tagName.toLowerCase();if(e.id){p.unshift(s+'#'+e.id);break}var c=e.className&&e.className.toString().trim().split(/\\s+/)[0];if(c)s+='.'+c;var pa=e.parentNode;if(pa){var sb=Array.prototype.filter.call(pa.children,function(z){return z.tagName===e.tagName});if(sb.length>1)s+=':nth-of-type('+(sb.indexOf(e)+1)+')'}p.unshift(s);e=e.parentNode}return p.join(' > ')}` +
      `function dp(e){var p=[];while(e&&e.nodeType===1){p.unshift(e.tagName.toLowerCase());e=e.parentNode}return p.join('/')}` +
      `function at(x,y){return document.elementFromPoint(x,y)}` +
      `function mm(e){var el=at(e.clientX,e.clientY);if(!el||el===ov||el===bn)return;var r=el.getBoundingClientRect();ov.style.left=r.left+'px';ov.style.top=r.top+'px';ov.style.width=r.width+'px';ov.style.height=r.height+'px'}` +
      `function ck(e){e.preventDefault();e.stopPropagation();var el=at(e.clientX,e.clientY);if(!el){return}var r=el.getBoundingClientRect();window.__topicsPick=JSON.stringify({cssPath:cp(el),domPath:dp(el),bbox:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},text:(el.innerText||el.textContent||'').trim().slice(0,120)});cl()}` +
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
          try {
            const info = JSON.parse(raw) as { cssPath: string; domPath: string; bbox: { x: number; y: number; w: number; h: number }; text: string };
            const payload = `Selected element on ${id}: ${info.cssPath} @ ${info.domPath} (bbox: ${info.bbox.x},${info.bbox.y},${info.bbox.w},${info.bbox.h})${info.text ? ` — "${info.text}"` : ''}`;
            window.dispatchEvent(new CustomEvent('chat:insert-text', { detail: { text: payload } }));
          } catch { /* malformed pick — ignore */ }
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
    try {
      ws = new WebSocket(`${serverWsBase()}/ws/browser/${encodeURIComponent(id)}`);
      const socket = ws;
      socket.addEventListener('open', () => {
        // Claim this contextId as a native executor (raw msg, outside the strict
        // browser-ws Zod envelope — the server handles it before parsing).
        try { socket.send(JSON.stringify({ type: 'register_native_executor' })); } catch { /* ignore */ }
      });
      socket.addEventListener('message', (e) => {
        let raw: unknown;
        try { raw = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
        const m = raw as { type?: string; opId?: string; tool?: string; args?: unknown; active?: boolean; action?: string };
        // Delegated agent op → execute on the native pane, reply with the result.
        if (m && m.type === 'browser_op' && typeof m.opId === 'string' && typeof m.tool === 'string') {
          void executeNativeBrowserOp(id, m.tool, m.args, tauriInvoke)
            .then((out) => {
              if (closed) return;
              try { socket.send(JSON.stringify({ type: 'browser_op_result', opId: m.opId, ...out })); } catch { /* ignore */ }
            });
          return;
        }
        // Otherwise it's a strict-envelope message (agent_active for the pill).
        const result = parseBrowserWsMessage(raw);
        if (!result.ok || result.data.type !== 'agent_active') return;
        setAgentActive(Boolean(result.data.active));
        if (result.data.active && result.data.action) setAgentAction(result.data.action);
      });
    } catch { /* ws construction failed — pill stays off, no delegation */ }
    return () => { closed = true; try { ws?.close(); } catch { /* ignore */ } };
  }, [id]);

  // Zoom via injected CSS (WKWebView has no JS zoom API; document zoom is the
  // portable stop-gap). delta is a step (+/-0.5 ≈ ±10%), 'reset' → 100%.
  const setZoom = useCallback(
    async (delta: number | 'reset'): Promise<number> => {
      const next = delta === 'reset' ? 100 : Math.min(300, Math.max(30, zoomRef.current + delta * 20));
      zoomRef.current = next;
      await tauriInvoke('browser_exec_js', {
        id,
        js: `document.documentElement.style.zoom='${next / 100}'`,
      }).catch(() => {});
      return next;
    },
    [id],
  );

  // Find-in-page via WebKit's window.find (highlights + scrolls to the match).
  const findInPage = useCallback(
    async (text: string, opts?: { forward?: boolean; findNext?: boolean }) => {
      const fwd = opts?.forward !== false;
      await tauriInvoke('browser_exec_js', {
        id,
        js: `try{window.find(${JSON.stringify(text)},false,${!fwd},true)}catch(e){}`,
      }).catch(() => {});
    },
    [id],
  );
  const stopFind = useCallback(async () => {
    await tauriInvoke('browser_exec_js', { id, js: 'try{getSelection().removeAllRanges()}catch(e){}' }).catch(() => {});
  }, [id]);

  // window.find gives no count, so count case-insensitive occurrences in the page
  // text ourselves (browser_eval_js returns the number stringified).
  const countMatches = useCallback(async (text: string): Promise<number> => {
    if (!text) return 0;
    const js =
      `(function(q){try{var t=(document.body&&document.body.innerText)||'';var lq=q.toLowerCase();` +
      `if(!t||!lq)return 0;var lc=t.toLowerCase(),n=0,i=0;while((i=lc.indexOf(lq,i))!==-1){n++;i+=lq.length}return n}catch(e){return 0}})(${JSON.stringify(text)})`;
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

  const consoleSummary = {
    errors: consoleEntries.reduce((n, e) => (e.level === 'error' ? n + 1 : n), 0),
    warnings: consoleEntries.reduce((n, e) => (e.level === 'warn' ? n + 1 : n), 0),
  };

  // Device emulation: pick the preset's dims + UA, letterbox the pane to them and
  // reload so the custom UA takes effect (WKWebView applies it on next load). The
  // UA override also flips navigator.userAgent, so emulation is real, not just a
  // resize. desktop/auto reset both.
  const setDevice = useCallback(
    (mode: DeviceMode, custom?: { width: number; height: number; deviceScaleFactor?: number }) => {
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
      void tauriInvoke('browser_set_user_agent', { id, ua })
        .then(() => tauriInvoke('browser_reload', { id }))
        .catch(() => {});
      applyBounds();
    },
    [id, applyBounds],
  );

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

  return {
    url,
    title,
    loading,
    agentActive,
    agentAction,
    ready,
    viewId: ready ? id : null,
    faviconUrl,
    frozenImage,
    navigate,
    goBack,
    goForward,
    reload,
    goHome,
    setBounds,
    toggleDevTools,
    findInPage,
    stopFind,
    onFindResult: () => () => {},
    setZoom,
    countMatches,
    inspectAt,
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
    getNavEntries: async () => ({ entries: [], activeIndex: 0 }),
    goToNavIndex: noop,
  };
}
