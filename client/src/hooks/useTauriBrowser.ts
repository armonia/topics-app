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
import { isOccluded, onOcclusionChange } from '../lib/shell/browserOcclusion';
import type { NativeBrowserHandle } from './useNativeBrowser';
import type { DeviceMode, BrowserConsoleEntry } from '@/components/Browser/browserDevTypes';

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
  const zoomRef = useRef(100); // page zoom percent (CSS-driven via exec_js)
  const consoleIdRef = useRef(0);

  const openedRef = useRef(false);
  // Buffer the last requested rect until the webview exists, then flush it — the
  // placeholder measures and calls setBounds before `browser_open` resolves.
  const pendingRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const initialUrlRef = useRef(initialUrl);

  const setBounds = useCallback(
    (b: { x: number; y: number; width: number; height: number }) => {
      // Park off-screen for an explicit zero-rect (drag/resize/hidden) OR while an
      // HTML overlay is open over it (native views composite above the DOM, so a
      // dropdown/modal would otherwise be hidden behind the page).
      const hide = b.width <= 0 || b.height <= 0 || isOccluded();
      const rect = hide ? OFFSCREEN : b;
      if (b.width > 0 && b.height > 0) pendingRectRef.current = b; // remember the real rect
      if (!openedRef.current) return; // flushed once open resolves
      void tauriInvoke('browser_set_bounds', {
        id,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }).catch(() => {});
    },
    [id],
  );

  // Overlay occlusion: park the webview while a dropdown/menu/modal is open,
  // restore (re-measure) when the last one closes. Native views can't be
  // z-ordered under DOM, so hiding is the parity-safe fix (the user's
  // "i dropdown vanno sotto il browser").
  useEffect(() => {
    return onOcclusionChange((occ) => {
      if (!openedRef.current) return;
      if (occ) {
        void tauriInvoke('browser_set_bounds', { id, ...OFFSCREEN }).catch(() => {});
      } else {
        // Bust the placeholder's coalescing cache so it re-issues the real rect.
        window.dispatchEvent(new CustomEvent('browser:reflow-request'));
      }
    });
  }, [id]);

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

  const clearConsole = useCallback(() => {
    setConsoleEntries([]);
    void tauriInvoke('browser_exec_js', { id, js: 'try{window.__topicsConsole&&(window.__topicsConsole.length=0)}catch(e){}' }).catch(() => {});
  }, [id]);

  const consoleSummary = {
    errors: consoleEntries.reduce((n, e) => (e.level === 'error' ? n + 1 : n), 0),
    warnings: consoleEntries.reduce((n, e) => (e.level === 'warn' ? n + 1 : n), 0),
  };

  return {
    url,
    title,
    loading,
    agentActive: false,
    agentAction: null,
    ready,
    viewId: ready ? id : null,
    faviconUrl,
    navigate,
    goBack,
    goForward,
    reload,
    goHome,
    setBounds,
    toggleDevTools: noop,
    findInPage,
    stopFind,
    onFindResult: () => () => {},
    setZoom,
    deviceMode: 'desktop' as DeviceMode,
    setDevice: () => {},
    responsiveSize: null,
    setResponsiveSize: () => {},
    consoleEntries,
    consoleSummary,
    clearConsole,
    getNavEntries: async () => ({ entries: [], activeIndex: 0 }),
    goToNavIndex: noop,
  };
}
