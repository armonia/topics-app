import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Copy, Check, RotateCw, Clock, AlertTriangle } from 'lucide-react';
import { attachTerminalTouchScroll } from './touchScroll';
import { createWriteCoalescer, BACKGROUND_FLUSH_MS, VISIBLE_FLUSH_MS, type WriteCoalescer } from './writeCoalescer';
import { enqueueFit, cancelFit } from '../../lib/staggeredFit';
import { serverWsBase } from '../../lib/shell/net';
import { isTauri } from '../../lib/shell';
import { tauriInvoke } from '../../lib/shell/tauri';
import { registerWrappedLinkProvider, openLinkExternally } from './wrappedLinkProvider';
import { signalsActions, useTerminalFinished, useTerminalReloading } from '../../state/signals';
import { useTerminalRosterAuthoritative, useTerminalSessions } from '../../contexts/TopicsContext';
import { shouldDeclareExpired } from '../../hooks/rosterTrust';
import { usePaneAlive } from '../../state/paneLiveness';
import { isWindowAwake } from '../../state/windowAwake';
import { useT } from '../../hooks/useT';
import { restartTerminalSession } from '../../lib/terminalReload';
import { useToast } from '../Shared/Toast';
import { TERMINAL_INPUT_DROPPED } from '../../../../shared/terminal-messages';

const TOUCH_KEYS: { label: string; data: string; wide?: boolean }[] = [
  { label: 'Esc',    data: '\x1b' },
  { label: 'Tab',    data: '\t' },
  { label: '↑',      data: '\x1b[A' },
  { label: '↓',      data: '\x1b[B' },
  { label: '←',      data: '\x1b[D' },
  { label: '→',      data: '\x1b[C' },
  { label: 'Ctrl+C', data: '\x03', wide: true },
  { label: 'Ctrl+D', data: '\x04', wide: true },
  { label: 'Ctrl+Z', data: '\x1a', wide: true },
];

const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window && navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|iPod/.test(navigator.userAgent);

const DARK_THEME = {
  // Near-neutral dark gray matched to the project sidebar's dark chrome. The
  // chrome is translucent vibrancy (reads gray, not blue), so an OPAQUE terminal
  // must stay near-neutral — at this low lightness any blue channel is amplified
  // and immediately reads "blue". Keep R/G/B within ~3 (whisper of cool, never
  // warm); darken to match the sidebar, never raise saturation.
  background: '#0d0e10',
  foreground: '#d4d4d8',
  cursor: '#a1a1aa',
  cursorAccent: '#0d0e10',
  selectionBackground: '#3f3f4640',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#0066ff30',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
};

function getTerminalTheme(isDark: boolean) {
  // xterm background is transparent so the container's .chrome-glass (the exact
  // frosted vibrancy of the project sidebar) shows through — identical CSS,
  // identical pixels. The container keeps an opaque fallback bg for non-Electron
  // web, where .chrome-glass is a no-op.
  return { ...(isDark ? DARK_THEME : LIGHT_THEME), background: 'rgba(0,0,0,0)' };
}

interface SingleTerminalPaneProps {
  sessionId: string;
  onStale?: () => void;
  /** True when this pane is the active/visible one. Defaults to true so call
   *  sites that don't pass it keep the old always-visible behavior. */
  isActive?: boolean;
}

/**
 * Quanto silenzio serve per considerare finito un resize della FINESTRA nativa.
 * Non esiste un evento di fine: 120ms è più lungo dell'intervallo fra due frame
 * di trascinamento (16ms) e abbastanza corto da non far percepire ritardo quando
 * si lascia il bordo.
 */
const WINDOW_RESIZE_SETTLE_MS = 120;

export function SingleTerminalPane({ sessionId, onStale, isActive = true }: SingleTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; ws: WebSocket } | null>(null);
  const [stale, setStale] = useState(false);

  // ── Cadenza di redraw ──────────────────────────────────────────────────
  // Scrivere su xterm schedula un redraw DOM: un TUI vivo (lo spinner di
  // claude-code) scrive a ogni frame, quindi ogni terminale montato ricostruisce
  // le righe 60 volte al secondo, ognuna con style resolve + layout della riga +
  // repaint dei glifi. Con più finestre progetto aperte è il costo a riposo
  // dominante dell'app (vedi writeCoalescer.ts per la misura). Quindi: ritmo
  // pieno solo quando questa pane è DAVVERO guardata — attiva, app a fuoco e
  // documento visibile — altrimenti si accumula e si scarica a ~4Hz, in ordine.
  const isWatchedRef = useRef(false);
  /** La pane ha un box nel layout? Falso dentro `display:none` (PaneKeepAlive).
   *
   *  Lo dice il context di vitalità (`usePaneAlive`), non più un
   *  IntersectionObserver per terminale. Il commento di prima sosteneva che
   *  l'observer "la consegna gratis, fuori dal main thread": è falso.
   *  `updateIntersectionObservations` gira DENTRO `updateRendering`, pretende un
   *  layout aggiornato, e per ogni bersaglio mappa il rect risalendo la catena
   *  dei container — che è esattamente
   *  `RenderBox::computeVisibleRectsInContainer`, ricorsivo su 10+ livelli, fra
   *  le voci più grosse del profilo del 2026-07-28. Con sedici PTY aperte erano
   *  sedici bersagli, ognuno rimappato a ogni frame.
   *
   *  E la risposta era già nota senza chiederla al motore: `display:none` sul
   *  guscio della pane È la definizione di "niente box", e il guscio lo sa
   *  perché è lui a metterlo. Qui il terminale riempie la pane e non vive dentro
   *  uno scroller, quindi "guscio visibile" e "ha un box" coincidono. */
  const hasLayoutRef = useRef(true);
  const paneAlive = usePaneAlive();
  useEffect(() => {
    const was = hasLayoutRef.current;
    hasLayoutRef.current = paneAlive;
    // Al ritorno del box si scarica l'arretrato: senza il flush si tornerebbe
    // sulla pane trovando lo schermo di prima. Era il compito del vecchio
    // observer, ed è l'unica cosa di lui che serviva davvero.
    if (paneAlive && !was) coalescerRef.current?.flush();
  }, [paneAlive]);
  /** La pane è quella attiva e la finestra è a fuoco — ma la tastiera potrebbe
   *  essere altrove (chat, un altro terminale dello split). Distingue la cadenza
   *  "visibile" da quella "in secondo piano". */
  const isVisibleRef = useRef(false);
  const coalescerRef = useRef<WriteCoalescer | null>(null);

  // ── Lossless reattach ──────────────────────────────────────────────────
  // The terminal-session list is broadcast by the server and sourced from the
  // PTY bridge, which keeps sessions alive across server reloads/restarts. So
  // the AUTHORITATIVE answer to "is this session still alive?" is "is it in
  // this list?" — NOT the WS close code. We use it to (a) keep reconnecting a
  // pane whose WS dropped during a reload/reconcile instead of dead-ending on
  // "expired", and (b) auto-recover a pane that already went stale the instant
  // its session reappears in the list. Read inside the connection effect via
  // refs so the (sessionId-keyed) xterm mount effect never re-runs on a list
  // change.
  const t = useT();
  // A refused restart has to be SAID: before, it ended in a `.catch(() => {})`.
  const toast = useToast();
  const terminalSessions = useTerminalSessions();
  const sessionListed = useMemo(
    () => terminalSessions.some((s) => s.id === sessionId),
    [terminalSessions, sessionId],
  );
  // Last-known session metadata, captured while the session is still in the
  // authoritative roster. A *stale* session is ABSENT from the roster, so at
  // overlay-time its live entry is already gone — we surface this snapshot
  // instead so the "expired" overlay can still report id / type / cwd / resume.
  const sessionInfo = useMemo(
    () => terminalSessions.find((s) => s.id === sessionId),
    [terminalSessions, sessionId],
  );
  const lastInfoRef = useRef<(typeof terminalSessions)[number] | null>(null);
  useEffect(() => { if (sessionInfo) lastInfoRef.current = sessionInfo; }, [sessionInfo]);
  const sessionListedRef = useRef(sessionListed);
  // Letto dentro `ws.onclose`, che vive nell'effetto keyed su sessionId e non
  // deve ri-eseguire quando il roster viene promosso: ref, come sessionListedRef.
  const rosterAuthoritative = useTerminalRosterAuthoritative();
  const rosterAuthoritativeRef = useRef(rosterAuthoritative);
  useEffect(() => { rosterAuthoritativeRef.current = rosterAuthoritative; }, [rosterAuthoritative]);
  const staleRef = useRef(stale);
  // The three banners are written into the TERMINAL, from inside a socket
  // handler that lives in an effect keyed on sessionId: a hook cannot be
  // called there, and re-running that effect on a language change would tear
  // down the xterm. A ref keeps the current translator reachable without
  // either. `expiredShownRef` remembers that the scrollback carries a line
  // saying the session is gone, so a successful reattach can correct it.
  const sayRef = useRef(t);
  useEffect(() => { sayRef.current = t; }, [t]);
  const expiredShownRef = useRef(false);
  const reconnectRef = useRef<(() => void) | null>(null);
  useEffect(() => { staleRef.current = stale; }, [stale]);

  // ── Dormant-empty detection ────────────────────────────────────────────
  // A claude/codex session whose PTY has EXITED stays in the roster (claude
  // rows are revivable, never deleted) but the bridge no longer holds its PTY:
  // the attach WS opens, `requestBuffer` returns zero bytes, and the server
  // never closes the socket — so the pane renders BLANK forever. That is the
  // "se ci clicco mi apre una finestra claude code vuota" when opening a
  // finished sub-agent: it is NOT `stale` (still listed), so no overlay shows.
  // We count output bytes since attach; a live claude TUI always replays its
  // drawn full-screen frame, so zero bytes at `replay-end` (+ none within a
  // grace) means the PTY is gone → surface the resume overlay instead of a
  // silent blank. Cleared the instant any output byte arrives (live session).
  const outputBytesRef = useRef(0);
  const dormantTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dormantEmpty, setDormantEmpty] = useState(false);
  const dormantEmptyRef = useRef(dormantEmpty);
  useEffect(() => { dormantEmptyRef.current = dormantEmpty; }, [dormantEmpty]);

  // THE FOURTH SILENCE: the keys that went nowhere.
  // When the PTY bridge is down the server drops the keystroke on purpose (see
  // the comment on the WS message handler in server/routes/terminal.ts) and
  // says so only in its own log. Here the socket stays open, the cursor keeps
  // blinking and xterm does no local echo, so typing into a dead terminal looks
  // exactly like typing into a live one. The server now sends a control frame;
  // this is the band, and it goes away at the first real byte of output.
  const [inputDropped, setInputDropped] = useState(false);
  const inputDroppedRef = useRef(inputDropped);
  useEffect(() => { inputDroppedRef.current = inputDropped; }, [inputDropped]);
  const clearInputDropped = useCallback(() => {
    if (inputDroppedRef.current) setInputDropped(false);
  }, []);

  // Viewing a claude-code session = its "finished a turn" notification is seen,
  // so clear it. Depending on `finished` (not just isActive) is what makes this
  // false-positive-proof: if the session finishes *while you're already looking
  // at it* (isActive stays true, so an [isActive,sessionId] effect would never
  // re-run), the badge would otherwise pop on a pane you're staring at. This
  // also kills the "I paused mid-typing" false finish — composing in an active
  // pane keeps it cleared.
  const finished = useTerminalFinished(sessionId);
  const reloading = useTerminalReloading(sessionId);
  useEffect(() => {
    if (isActive && finished) signalsActions.clearTerminalFinished(sessionId);
  }, [isActive, finished, sessionId]);

  // Chi decide la cadenza. Stessa soglia di `useAnimationPause` (documento
  // visibile + finestra a fuoco), più "questa pane è quella attiva". Il flush al
  // passaggio a "guardato" è obbligatorio: senza, tornare sulla pane mostrerebbe
  // uno schermo vecchio fino allo scadere del timer.
  useEffect(() => {
    const sync = () => {
      // `isWindowAwake()` e non `!document.hidden && document.hasFocus()`: con una
      // pane browser NATIVA key, il documento ospite legge hasFocus()=false
      // mentre l'utente sta usando l'app, e questo terminale precipitava da
      // 15 Hz a 4 — il "terminale che lagga". Vedi state/windowAwake.ts.
      const visible = isActive && isWindowAwake();
      isVisibleRef.current = visible;
      // Scrittura IMMEDIATA solo dove c'è un eco da rendere immediato, cioè dove
      // sta il cursore della tastiera. Gli altri terminali visibili mostrano
      // output e basta: vanno benissimo a VISIBLE_FLUSH_MS, e così smettono di
      // sporcare il layout a ogni frame tutti insieme.
      const el = containerRef.current;
      const focused = visible && !!el && el.contains(document.activeElement);
      const wasWatched = isWatchedRef.current;
      isWatchedRef.current = focused;
      if (focused && !wasWatched) coalescerRef.current?.flush();
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    // Il fuoco si sposta anche DENTRO il documento (da un terminale all'altro,
    // o verso la chat) senza che la finestra lo perda: senza questi due il
    // terminale appena lasciato resterebbe in scrittura immediata.
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);

    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
    };
  }, [isActive]);

  const [copied, setCopied] = useState(false);
  const isDarkRef = useRef(document.documentElement.classList.contains('dark'));

  // Track dark/light theme
  useEffect(() => {
    const check = () => {
      const dark = document.documentElement.classList.contains('dark');
      isDarkRef.current = dark;
      if (termRef.current) {
        termRef.current.term.options.theme = { ...getTerminalTheme(dark) };
      }
    };
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Mount terminal
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Track intentional cleanup to avoid setting stale on unmount
    let intentionalClose = false;

    setStale(false); // Reset stale on (re)mount
    setDormantEmpty(false);
    outputBytesRef.current = 0;
    if (dormantTimerRef.current) { clearTimeout(dormantTimerRef.current); dormantTimerRef.current = null; }

    const term = new Terminal({
      theme: getTerminalTheme(isDarkRef.current),
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      allowTransparency: true,
      // @ts-expect-error copyOnSelect exists at runtime but missing from v6 types
      copyOnSelect: true,
      // Renderer: DOM (xterm v6 default) — KEPT ON PURPOSE on every platform, not
      // just a mobile concession. A GPU renderer is disqualified three ways here:
      //  • WebGL breaks our non-negotiable transparency — `allowTransparency:true`
      //    over the native vibrancy triggers the open thin/black-text bug
      //    (xtermjs/xterm.js#4212, unfixed, no workaround).
      //  • Up to ~9 terminals mount at once; one WebGL context each hits Chromium's
      //    ~16-context cap, which silently kills the OLDEST → panes go blank on churn.
      //  • It stacks a second silent blank-screen failure onto a window already
      //    fragile across sleep/wake + display changes (see recomposeWindow).
      // Canvas2D is not an option either: the canvas addon was REMOVED in xterm v6
      // (the pinned @xterm/addon-canvas only loads behind the demo flag below).
      // DOM is the unique renderer that is transparent, context-free, crisp at any
      // DPR, and gives mobile native text selection — and it's every GPU renderer's
      // own fallback anyway. Revisit only if profiling MEASURES DOM dropping frames
      // on the active pane, and then behind a global 1-context WebGL cap.
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Ogni byte del PTY passa da qui, mai da `term.write` diretto: il coalescer
    // decide se ridisegnare subito o accumulare, e scavalcarlo romperebbe
    // l'ordine dei byte (quindi lo stato ANSI) contro l'arretrato in coda.
    const coalescer = createWriteCoalescer({
      write: (chunk) => term.write(chunk),
      isWatched: () => isWatchedRef.current,
      hasLayout: () => hasLayoutRef.current,
      flushMs: () => (isVisibleRef.current ? VISIBLE_FLUSH_MS : BACKGROUND_FLUSH_MS),
    });
    coalescerRef.current = coalescer;

    // Renderer: DOM on EVERY host, including Tauri/WebKit. The Canvas addon
    // (@xterm/addon-canvas) is pinned to xterm core v5 — `peerDependencies:
    // "@xterm/xterm": "^5.0.0"`, still true even of 0.8.0-beta — and CRASHES on
    // our xterm v6 core at RENDER time: `this._linkifier2.onShowLinkUnderline`
    // is undefined because the core's internal link service moved in v6. The
    // try/catch around loadAddon only catches a synchronous LOAD throw, not the
    // later render-time access, so it reported a false "canvasOk" while the
    // terminal blew up on first paint. (Was gated on `isTauri` for an 8-way
    // sidebar-reclaim win — now moot: the sidebar push is a compositor FLIP
    // (useSidebarFlipPush), not a per-frame row relayout, so DOM no longer
    // reflows terminals during the slide.) DOM is transparent (keeps the frosted
    // glass — unlike WebGL bug #4212), crisp at any DPR, and gives native text
    // selection. The demo flag below remains ONLY for the landing page's block-
    // art logo and is itself v6-incompatible — never set it in the app.
    if ((window as unknown as { __TOPICS_DEMO_CANVAS__?: boolean }).__TOPICS_DEMO_CANVAS__) {
      import('@xterm/addon-canvas')
        .then(({ CanvasAddon }) => { try { term.loadAddon(new CanvasAddon()); } catch { /* DOM fallback */ } })
        .catch(() => { /* DOM fallback */ });
    }

    registerWrappedLinkProvider(term, openLinkExternally);

    // Cmd+C (mac) or Ctrl+Shift+C: copy selection without sending SIGINT
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const isCopy = (e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key === 'c' && e.type === 'keydown';
      if (isCopy && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false; // prevent default xterm handling
      }
      return true;
    });

    // Intercept paste events with images — upload to server, copy to system clipboard,
    // then trigger a paste so Claude Code can detect the image via clipboard read
    const handleImagePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      let imageItem: DataTransferItem | null = null;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) return; // no image, let xterm handle text paste normally

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      // Put the pasted image on the system clipboard NATIVELY, then send Ctrl+V
      // so Claude Code reads it. No server round-trip and no `osascript` (which
      // was triggering a macOS "control iTunes/Music" Automation prompt):
      //   • Tauri  → NSPasteboard via the set_clipboard_image command
      //   • Web    → the browser Clipboard API
      void (async () => {
        const writeViaBrowser = async () => {
          const type = blob.type || 'image/png';
          await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        };
        try {
          if (isTauri) {
            // Native NSPasteboard. Falls back to the browser Clipboard API when
            // the command isn't present yet (app built before this change), so
            // paste keeps working without waiting for an app rebuild.
            try {
              const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
              await tauriInvoke('set_clipboard_image', { bytes });
            } catch {
              await writeViaBrowser();
            }
          } else {
            await writeViaBrowser();
          }
          const activeWs = termRef.current?.ws;
          if (activeWs && activeWs.readyState === WebSocket.OPEN) {
            activeWs.send('\x16');
          }
        } catch (err) {
          console.error('Image paste failed:', err);
        }
      })();
    };

    el.addEventListener('paste', handleImagePaste as unknown as EventListener, true);

    const detachTouchScroll = attachTerminalTouchScroll(el, term);

    const doFit = () => { try { fitAddon.fit(); } catch {} };
    setTimeout(doFit, 50);
    setTimeout(doFit, 200);
    setTimeout(doFit, 500);
    setTimeout(() => { doFit(); term.focus(); }, 600);

    let retryCount = 0;
    // Grace window for the boot/reconcile race: an attach can fire before the
    // session list has (re)populated. We retry this many times even while the
    // session looks absent, so a live session never false-expires before the
    // authoritative list has had a chance to load. Beyond the grace, the list
    // is the sole arbiter: listed → keep retrying (lossless); absent → expired.
    const RECONCILE_GRACE_RETRIES = 5;
    let retryTimer: ReturnType<typeof setTimeout>;

    // The server sends a `{type:"replay-end"}` text frame after flushing the
    // scrollback backlog (see server/routes/terminal.ts). It's a control frame,
    // so we consume it (below) without rendering the JSON to the terminal.

    function connectWs() {
      const ws = new WebSocket(`${serverWsBase()}/ws/terminal/${sessionId}`);
      ws.binaryType = 'arraybuffer';
      // Update ref so onData/paste always use the current WS
      if (termRef.current) {
        termRef.current.ws = ws;
      }

      ws.onopen = () => {
        retryCount = 0;
        setStale(false);
        // A banner that lies is worse than one in the wrong language. The
        // "expired" line is written into the SCROLLBACK, so a later successful
        // reattach used to leave it sitting there for good, above live output,
        // saying the session was gone. It cannot be deleted (that would delete
        // real output with it), so the record gets corrected instead.
        if (expiredShownRef.current) {
          expiredShownRef.current = false;
          coalescer.push(`\r\n\x1b[90m[${sayRef.current('terminal.banner.reattached')}]\x1b[0m\r\n`);
        }
        // Each fresh attach is judged on its own: reset the byte counter and
        // any pending dormant grace so a reconnect (server reload, resume) can
        // clear a previously-shown empty overlay once real output flows again.
        setDormantEmpty(false);
        clearInputDropped();
        outputBytesRef.current = 0;
        if (dormantTimerRef.current) { clearTimeout(dormantTimerRef.current); dormantTimerRef.current = null; }
        // A "Ricarica" reload reconnects here — drop the "Riavvio…" overlay.
        signalsActions.clearTerminalReloading(sessionId);
        fetch(`/api/terminal/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => {});
      };

      ws.onmessage = (ev) => {
        const data = ev.data;
        if (typeof data === 'string') {
          // Text frames are reserved for control messages from the server.
          // The only one today is `{type:"replay-end"}` (sent after the
          // scrollback backlog is flushed) — consume it without rendering the
          // JSON. Anything else is treated as plain output for forward compat.
          try {
            const msg = JSON.parse(data);
            if (msg && msg.type === TERMINAL_INPUT_DROPPED) {
              setInputDropped(true);
              return;
            }
            if (msg && msg.type === 'replay-end') {
              // Zero output bytes at replay-end on a resumable (claude/codex)
              // session ⇒ its PTY is almost certainly gone (a live claude TUI
              // always replays its drawn full-screen frame). Arm a short grace;
              // if no live output arrives, show the resume overlay instead of a
              // silent blank pane. A shell has no full-screen frame and can be
              // legitimately empty, so it's excluded — it also can't be resumed.
              const info = lastInfoRef.current;
              const t = info?.type;
              // Elencare i tipi a mano qui aveva gia' lasciato fuori 'opencode':
              // una sua pane con la PTY morta restava BIANCA, senza l'overlay
              // «Sessione terminata» e quindi senza il bottone per ripartire.
              // La regola vera e' negativa — si esclude la shell, che non ha un
              // frame a schermo intero da riprodurre e non e' ripristinabile —
              // quindi si scrive quella, e ogni agente futuro e' coperto.
              const resumable = !!t && t !== 'shell';
              // A FINISHED session is by definition old; a freshly-spawned one is
              // young and may just be slow to draw its first frame (cold start).
              // Gating on age >10s removes the only false-positive — a brief
              // "Sessione terminata" flash on a booting new pane before its TUI
              // paints — without missing any genuinely dead PTY.
              const ageMs = info?.createdAt ? Date.now() - new Date(info.createdAt).getTime() : Infinity;
              if (resumable && outputBytesRef.current === 0 && ageMs > 10_000) {
                if (dormantTimerRef.current) clearTimeout(dormantTimerRef.current);
                dormantTimerRef.current = setTimeout(() => {
                  dormantTimerRef.current = null;
                  if (outputBytesRef.current === 0) setDormantEmpty(true);
                }, 2000);
              }
              return;
            }
          } catch { /* not JSON — write as-is */ }
          coalescer.push(data);
          outputBytesRef.current += data.length;
          clearInputDropped();
          if (dormantEmptyRef.current) setDormantEmpty(false);
          if (dormantTimerRef.current) { clearTimeout(dormantTimerRef.current); dormantTimerRef.current = null; }
        } else if (data instanceof ArrayBuffer) {
          coalescer.push(new Uint8Array(data));
          outputBytesRef.current += data.byteLength;
          clearInputDropped();
          if (dormantEmptyRef.current) setDormantEmpty(false);
          if (dormantTimerRef.current) { clearTimeout(dormantTimerRef.current); dormantTimerRef.current = null; }
        }
      };

      ws.onclose = (event) => {
        if (intentionalClose) return;
        if (event.code === 1000) {
          // Clean end — the PTY exited (`exit`, process finished). Not a
          // reconnect candidate; the session drops from the list on its own.
          coalescer.push(`\r\n\x1b[90m[${sayRef.current('terminal.banner.ended')}]\x1b[0m\r\n`);
          return;
        }
        // 1008 ("session not found") or any abnormal close. The PTY bridge
        // keeps sessions alive across server reloads/restarts/reconciles, so
        // this is TRANSIENT as long as the session is still in the
        // authoritative list. Keep reconnecting; declare the pane expired only
        // once the session has actually left the broadcast list. While listed
        // we retry indefinitely (capped backoff) — that's the lossless
        // property: a reload can't strand a terminal whose session is alive.
        retryCount++;
        // La decisione vive in `hooks/rosterTrust.ts` — pura e testata, perché è
        // quella che ha prodotto "Sessione scaduta" su terminali VIVI e nessun
        // test la copriva. Il gate nuovo (2026-07-30) è `rosterAuthoritative`:
        // finché il roster non è stato confermato, la sua assenza non prova
        // niente, dato che il server risponde `200 []` finché `reconcileSessions`
        // non ha finito e `Bun.serve` non lo attende.
        if (!shouldDeclareExpired({
          sessionListed: sessionListedRef.current,
          rosterAuthoritative: rosterAuthoritativeRef.current,
          retryCount,
          graceRetries: RECONCILE_GRACE_RETRIES,
        })) {
          const delay = Math.min(500 * retryCount, 3000);
          retryTimer = setTimeout(connectWs, delay);
        } else {
          coalescer.push(`\r\n\x1b[90m[${sayRef.current('terminal.banner.expired')}]\x1b[0m\r\n`);
          expiredShownRef.current = true;
          setStale(true);
          onStale?.();
        }
      };

      return ws;
    }

    // Exposed so the lossless-recovery effect (below) can force a reconnect
    // when a stale pane's session reappears in the authoritative list. No-op
    // if a connection is already open/opening, so it can't create a duplicate
    // socket racing the live one.
    reconnectRef.current = () => {
      const cur = termRef.current?.ws;
      if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
      clearTimeout(retryTimer);
      retryCount = 0;
      connectWs();
    };

    const initialWs = connectWs();

    term.onData((data) => {
      const ws = termRef.current?.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      // Only an ACTIVE window drives the shared PTY size so background windows
      // (browser vs Electron) don't fight over it. On desktop "active" = focused.
      // BUT on touch devices `document.hasFocus()` is unreliable — iOS PWAs
      // frequently report false even while in the foreground — so the mobile
      // client never resized the shared PTY: it stayed sized for some other
      // (desktop) client and the mobile xterm rendered the TUI with a big band
      // of empty rows below it (the "spazio sotto" on the phone). A VISIBLE
      // touch client therefore counts as active too.
      const active = document.hasFocus() || (isTouchDevice && document.visibilityState === 'visible');
      if (!active) return;
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    });

    termRef.current = { term, fit: fitAddon, ws: initialWs };

    return () => {
      intentionalClose = true;
      clearTimeout(retryTimer);
      if (dormantTimerRef.current) { clearTimeout(dormantTimerRef.current); dormantTimerRef.current = null; }
      reconnectRef.current = null;
      detachTouchScroll();
      el.removeEventListener('paste', handleImagePaste as unknown as EventListener, true);
      termRef.current?.ws.close();
      coalescer.dispose();
      coalescerRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lossless recovery — see the "Lossless reattach" note up top. Keep the
  // session-presence ref current for the connection effect's close handler,
  // and when a pane that already went stale finds its session back in the
  // authoritative list (reconcile completed, server returned, dormant session
  // revived), clear the overlay and reconnect. Keyed on `sessionListed` only
  // so it never disturbs the xterm mount effect.
  useEffect(() => {
    sessionListedRef.current = sessionListed;
    if (sessionListed && staleRef.current) {
      setStale(false);
      reconnectRef.current?.();
    }
  }, [sessionListed]);

  // ── Rianimazione automatica di una sessione DORMIENTE ──────────────────
  //
  // Una sessione claude può uscire dal roster mentre la sua pane resta montata:
  // la CLI termina da sola, oppure il server la PARCHEGGIA perché ferma da
  // troppo (`TOPICS_TERMINAL_IDLE_PARK_MS`, vedi lib/terminal-idle-park.ts). In
  // entrambi i casi la riga resta `dormant` e `--resume` la riporterebbe
  // esattamente dov'era — ma finora l'unica strada era l'overlay «Sessione
  // scaduta» e un click su Ricarica.
  //
  // Va bene per una CLI che è finita da sola: te ne accorgi ed è un'informazione.
  // NON va bene per un parcheggio: sarebbe il meccanismo che lascia in giro il
  // proprio sporco, tredici tab da ricliccare per un risparmio che doveva essere
  // invisibile. Quindi quando la pane torna ATTIVA e la sua sessione è dormiente,
  // la si rianima e basta.
  //
  // Gate su `isActive`: si rianima ciò che si sta guardando, non tutte le pane
  // montate. Rianimarle tutte rimetterebbe in piedi in un colpo solo proprio i
  // processi che il parcheggio ha spento.
  const revivingRef = useRef(false);
  useEffect(() => {
    if (!isActive || !stale || revivingRef.current) return;
    let cancelled = false;
    revivingRef.current = true;
    void (async () => {
      try {
        const res = await fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/revive`, {
          method: 'POST',
        });
        // 404 = la sessione non è dormiente, è proprio sparita (riga cancellata).
        // Allora «Sessione scaduta» è la verità e l'overlay resta: il bottone
        // Ricarica è l'unica strada, ed è giusto che si veda.
        if (!res.ok || cancelled) return;
        setStale(false);
        reconnectRef.current?.();
      } catch {
        /* rete giù: l'overlay resta, e il tentativo si ripete al prossimo giro */
      } finally {
        if (!cancelled) revivingRef.current = false;
      }
    })();
    return () => { cancelled = true; revivingRef.current = false; };
  }, [isActive, stale, sessionId]);

  // Resize observer. A divider drag resizes this pane's container on every
  // animation frame; fitting xterm per frame resizes its canvas layers and
  // repaints the whole grid each time — a continuous flicker for the length of
  // the drag (the demo's "le finestre flashano"). useGridResize brackets a real
  // drag with 'topics:pane-resize-start' / '-end', so coalesce: hold the fits
  // while a drag is live and run exactly one fit when it ends, at the settled
  // geometry. Lo stesso vale ora per il resize della FINESTRA nativa, che non
  // emette parentesi e se le auto-genera (vedi WINDOW_RESIZE_SETTLE_MS):
  // restano immediate solo le variazioni ISOLATE di dimensione, quelle per cui
  // aspettare non avrebbe senso.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // REF-COUNT, not a bare boolean: pane-resize (divider drag) and sidebar-resize
    // (collapse/expand) are INDEPENDENT brackets that can overlap. A bare flag let a
    // sidebar-resize-end clear `resizing` mid divider-drag → per-frame fit thrash for
    // the rest of the drag. Count concurrent brackets; only resume fits at depth 0.
    // Mirrors NativeBrowserPlaceholder's drag ref-count.
    let resizeDepth = 0;
    let missed = false;
    const fit = () => { if (termRef.current) { try { termRef.current.fit.fit(); } catch {} } };
    // Stagger fits ONE PER FRAME (staggeredFit): N terminals fitting in one tick thrash
    // layout (each fit reads layout after the previous wrote → full reflow per fit →
    // ~570ms for 8 on a sidebar reclaim). Spreading lets layout settle between fits so
    // each is cheap, and the app stays interactive. Dedupes per terminal.
    const handleResize = () => { if (resizeDepth > 0) { missed = true; return; } enqueueFit(fit); };
    const onResizeStart = () => { resizeDepth += 1; };
    const onResizeEnd = () => {
      resizeDepth = Math.max(0, resizeDepth - 1);
      if (resizeDepth === 0 && missed) { missed = false; enqueueFit(fit); }
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(el);
    // Coalesce fits during BOTH a divider drag (pane-resize-*) and a sidebar
    // collapse/expand (sidebar-resize-*): per-frame fit() over a 200ms slide forces a
    // layout + row-DOM rebuild each frame (~190-300ms jank for ~6 terminals → measured).
    // Holding the fits and running one at the settled size drops that to a single ~84ms
    // re-fit. See useSidebarFitCoalesce for the sidebar dispatcher.
    window.addEventListener('topics:pane-resize-start', onResizeStart);
    window.addEventListener('topics:pane-resize-end', onResizeEnd);
    window.addEventListener('topics:sidebar-resize-start', onResizeStart);
    window.addEventListener('topics:sidebar-resize-end', onResizeEnd);

    // …E ANCHE il resize della FINESTRA NATIVA, che era l'unico caso rimasto
    // scoperto. Trascinare il bordo della finestra non emette nessuna delle
    // parentesi qui sopra — quelle le emette l'app per i propri divider — quindi
    // ogni terminale rifaceva `fit()` a OGNI frame del trascinamento: misura,
    // ricostruzione delle righe e reflow completo, moltiplicati per il numero di
    // terminali montati. È il picco di CPU che si vede ridimensionando la
    // finestra (~80%, riferito da Attilio 2026-07-28).
    //
    // Il resize nativo non ha un evento di "fine", quindi la parentesi si chiude
    // da sola: si apre al primo `resize` e si richiude WINDOW_RESIZE_SETTLE_MS
    // dopo l'ultimo. Il `fit` finale arriva comunque, perché `handleResize` nel
    // frattempo ha alzato `missed` e `onResizeEnd` lo consuma.
    let winResizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onWindowResize = () => {
      if (winResizeTimer === null) onResizeStart();
      else clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        onResizeEnd();
      }, WINDOW_RESIZE_SETTLE_MS);
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      observer.disconnect();
      cancelFit(fit); // drop any queued fit so we never call into a disposed terminal
      window.removeEventListener('topics:pane-resize-start', onResizeStart);
      window.removeEventListener('topics:pane-resize-end', onResizeEnd);
      window.removeEventListener('topics:sidebar-resize-start', onResizeStart);
      window.removeEventListener('topics:sidebar-resize-end', onResizeEnd);
      window.removeEventListener('resize', onWindowResize);
      // Parentesi aperta e mai chiusa = fit congelati per sempre: se lo
      // smontaggio capita in mezzo a un resize, la si chiude qui.
      if (winResizeTimer !== null) { clearTimeout(winResizeTimer); onResizeEnd(); }
    };
  }, []);

  // When window gains focus, re-fit and force-send dimensions to server.
  // Another window may have resized the shared PTY while this one was in background.
  // fit() alone won't help if this window's size hasn't changed (xterm skips onResize
  // when cols/rows are unchanged), so we force-send the current size.
  useEffect(() => {
    const handleFocus = () => {
      const ref = termRef.current;
      if (!ref) return;
      try { ref.fit.fit(); } catch {}
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: ref.term.cols, rows: ref.term.rows }),
      }).catch(() => {});
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [sessionId]);

  // When this pane becomes the ACTIVE/visible tab, re-fit and force-send the
  // current size to the shared PTY. Switching tabs inside an already-focused
  // window fires NEITHER `window.focus` (the window never lost focus) NOR
  // `document.visibilitychange` (the document stayed visible), and the
  // ResizeObserver is a no-op when the container size didn't change — so if the
  // shared PTY was resized by another tab/window/client while this tab was
  // `display:none`, a full-screen TUI like Claude Code stays drawn at that stale
  // geometry (clipped / overflowing) until you manually resize the window. This
  // is the "ogni tanto si perde la finestra e devo resizarla" bug. Force-sending
  // the size triggers a SIGWINCH → the TUI repaints at the right size, and
  // `refresh()` repaints xterm's own viewport immediately. The rAF lets the
  // just-shown element settle its layout before `fit()` measures it.
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      const ref = termRef.current;
      if (!ref) return;
      try { ref.fit.fit(); } catch {}
      try { ref.term.refresh(0, ref.term.rows - 1); } catch {}
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: ref.term.cols, rows: ref.term.rows }),
      }).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, sessionId]);

  // Touch devices: when the PWA returns to the foreground, re-fit and force-send
  // dimensions. `document.hasFocus()` can't be relied on here (see onResize), so
  // visibility is the trigger that the user is actually looking at this terminal.
  useEffect(() => {
    if (!isTouchDevice) return;
    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ref = termRef.current;
      if (!ref) return;
      try { ref.fit.fit(); } catch {}
      fetch(`/api/terminal/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: ref.term.cols, rows: ref.term.rows }),
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', handleVisible);
    return () => document.removeEventListener('visibilitychange', handleVisible);
  }, [sessionId]);

  const handleCopyOutput = () => {
    const term = termRef.current?.term;
    if (!term) return;
    // Copy selection if any, otherwise copy last 200 lines of scrollback
    const text = term.hasSelection()
      ? term.getSelection()
      : (() => {
          const buf = term.buffer.active;
          const lines: string[] = [];
          const start = Math.max(0, buf.length - 200);
          for (let i = start; i < buf.length; i++) {
            lines.push(buf.getLine(i)?.translateToString(true) ?? '');
          }
          return lines.join('\n').trimEnd();
        })();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const sendToTerminal = (data: string) => {
    const ws = termRef.current?.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  return (
    <div data-testid="single-terminal-pane" className="flex-1 min-h-0 flex flex-col">
      {/* Virtual key toolbar — touch devices only.
          Fondo bg-[#111] scuro in ENTRAMBI i temi, quindi i `bg-white/N` qui sotto
          sono il rialzo corretto (bianco su nero) — è l'eccezione alla regola in
          index.css, non un bug da tema chiaro. */}
      {isTouchDevice && !stale && (
        <div className="flex-shrink-0 flex items-center gap-1 px-2 py-[5px] bg-[#111] border-b border-white/10 overflow-x-auto select-none">
          {TOUCH_KEYS.map(({ label, data, wide }) => (
            <button
              key={label}
              onPointerDown={(e) => { e.preventDefault(); sendToTerminal(data); }}
              className={`flex-shrink-0 px-2 py-[3px] rounded bg-white/10 text-white text-[11px] font-mono active:bg-white/30 transition-colors ${wide ? 'px-3' : ''}`}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={handleCopyOutput}
            className="flex-shrink-0 flex items-center gap-1 px-2 py-[3px] rounded bg-white/10 text-white text-[11px] active:bg-white/30 transition-colors"
            title={t('terminal.copyOutput')}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? t('terminal.copied') : t('terminal.copy')}</span>
          </button>
        </div>
      )}

      {/* Terminal area — chrome-glass matches the project sidebar's frosted
          vibrancy under Electron (xterm bg is transparent so it shows through);
          inline bg is the opaque web fallback + covers any sub-cell edge gap.

          `contain: layout paint` = CONFINE DI LAYOUT. Il renderer DOM di xterm
          ricostruisce le righe con `replaceChildren` a ogni scarico: senza
          contenimento quella sporcizia risale fino alla radice, e siccome il
          layout flex NON è incrementale (un container che si rilaya rilaya TUTTI
          i suoi figli) un singolo carattere in un terminale rilayava l'INTERO
          albero delle pane — 10+ livelli di flex annidati, ~9ms. Peggio: con un
          campo di testo a fuoco, `OpacityCaretAnimator` forza un
          `Document::updateLayout()` sincrono ad ogni rendering update, quindi
          quel layout lo pagavamo anche una seconda volta per frame (misurato con
          `sample` sul WebContent: 2425 campioni su 3426 del main thread).
          Contenendo, il ricalcolo si ferma al bordo del terminale.
          `paint` è gratis qui — `overflow-hidden` già ritaglia — e nessun
          discendente è `position: fixed` (xterm, il ring e il bottone copia sono
          tutti `absolute` dentro questo stesso box, che era già il loro
          containing block via `relative`). */}
      <div
        className="flex-1 min-h-0 relative overflow-hidden chrome-glass"
        style={{
          backgroundColor: isDarkRef.current ? DARK_THEME.background : LIGHT_THEME.background,
          contain: 'layout paint',
        }}
      >
        <div
          ref={containerRef}
          className="absolute inset-0"
          onClick={() => termRef.current?.term.focus()}
        />
        {/* Copy button for non-touch */}
        {!isTouchDevice && !stale && (
          <button
            onClick={handleCopyOutput}
            // backdrop-blur ONLY on hover: the button is opacity-0 at rest, but a
            // base `backdrop-blur` would still create a persistent blur(8px)
            // compositor layer that the GPU re-samples every frame — and these
            // tile across every visible terminal (9 invisible blurs = a big chunk
            // of GPU compositing, measured via CDP trace). Gating it to hover keeps
            // the exact glass look when shown and drops the idle GPU cost to zero.
            className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-md bg-black/40 text-white text-[11px] opacity-0 hover:opacity-100 hover:backdrop-blur-sm transition-opacity"
            title={t('terminal.copyOutput')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? t('terminal.copied') : t('terminal.copy')}</span>
          </button>
        )}
        {stale && (
          <div data-testid="terminal-stale-overlay" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/80 z-10 px-4">
            <div className="flex items-center gap-1.5 text-app-text-muted text-[12px]">
              <Clock size={13} />
              <span>{t('terminal.stale.title')}</span>
            </div>
            {(() => {
              const info = lastInfoRef.current;
              return (
                <div
                  data-testid="terminal-stale-info"
                  className="flex max-w-full flex-col items-center gap-0.5 break-all text-center font-mono text-[10px] leading-relaxed text-app-text-muted/70"
                >
                  {info?.type && (
                    <span>{info.type}{info.cwd ? ` · ${info.cwd}` : ''}</span>
                  )}
                  <span>
                    id {sessionId.slice(0, 8)}
                    {info?.claudeSessionId && (
                      <>
                        {' · '}
                        {/* Il verso opposto dell'adozione: da qui esce il comando
                            per riprendere QUESTA conversazione in un terminale
                            qualsiasi. Mostrare otto caratteri non basta — con
                            `claude --resume` serve l'id INTERO, e ricopiarlo a
                            mano da uno schermo e' esattamente il genere di cosa
                            che si sbaglia. Un click mette negli appunti il
                            comando completo, non solo l'id. */}
                        <button
                          onClick={() => {
                            const cmd = `claude --resume ${info.claudeSessionId}`;
                            try { void navigator.clipboard?.writeText(cmd); } catch { /* clipboard negata */ }
                          }}
                          title={t('terminal.copyResume', { id: info.claudeSessionId })}
                          className="underline decoration-dotted underline-offset-2 hover:text-app-text"
                        >resume {info.claudeSessionId.slice(0, 8)}</button>
                      </>
                    )}
                  </span>
                </div>
              );
            })()}
            {/* Self-service recovery: the same in-place reload as the tab's
                "Ricarica" menu item — for claude/codex this resumes the
                conversation (--resume), so the session isn't a dead-end. */}
            <button
              type="button"
              disabled={reloading}
              onClick={() => {
                restartTerminalSession(sessionId, toast, t);
              }}
              title={t('terminal.reloadTitle')}
              className="flex items-center gap-1.5 rounded-md bg-black/40 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-black/55 disabled:opacity-50"
            >
              <RotateCw size={13} className={reloading ? 'animate-spin' : ''} />
              <span>{reloading ? t('terminal.restarting') : t('terminal.reload')}</span>
            </button>
          </div>
        )}
        {/* Dormant-empty overlay — the session is still in the roster (revivable)
            but its PTY has exited, so the attach replayed nothing and the pane
            would otherwise be a silent blank ("finestra claude code vuota" when
            opening a finished sub-agent). Same resume affordance as the stale
            overlay: one click --resumes the conversation and brings it back live.
            Distinct from `stale` on purpose — a listed session must not trip the
            lossless-reconnect effect, so this owns its own state. */}
        {dormantEmpty && !stale && !reloading && (
          <div data-testid="terminal-dormant-overlay" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/80 z-10 px-4">
            <div className="flex items-center gap-1.5 text-app-text-muted text-[12px]">
              <Clock size={13} />
              <span>{t('terminal.dormant.title')}</span>
            </div>
            {(() => {
              const info = lastInfoRef.current;
              return (
                <div
                  data-testid="terminal-dormant-info"
                  className="flex max-w-full flex-col items-center gap-0.5 break-all text-center font-mono text-[10px] leading-relaxed text-app-text-muted/70"
                >
                  {info?.type && (
                    <span>{info.type}{info.cwd ? ` · ${info.cwd}` : ''}</span>
                  )}
                  <span>
                    id {sessionId.slice(0, 8)}
                    {info?.claudeSessionId && (
                      <>
                        {' · '}
                        {/* Il verso opposto dell'adozione: da qui esce il comando
                            per riprendere QUESTA conversazione in un terminale
                            qualsiasi. Mostrare otto caratteri non basta — con
                            `claude --resume` serve l'id INTERO, e ricopiarlo a
                            mano da uno schermo e' esattamente il genere di cosa
                            che si sbaglia. Un click mette negli appunti il
                            comando completo, non solo l'id. */}
                        <button
                          onClick={() => {
                            const cmd = `claude --resume ${info.claudeSessionId}`;
                            try { void navigator.clipboard?.writeText(cmd); } catch { /* clipboard negata */ }
                          }}
                          title={t('terminal.copyResume', { id: info.claudeSessionId })}
                          className="underline decoration-dotted underline-offset-2 hover:text-app-text"
                        >resume {info.claudeSessionId.slice(0, 8)}</button>
                      </>
                    )}
                  </span>
                </div>
              );
            })()}
            <button
              type="button"
              disabled={reloading}
              onClick={() => {
                restartTerminalSession(sessionId, toast, t);
              }}
              title={t('terminal.resumeTitle')}
              className="flex items-center gap-1.5 rounded-md bg-black/40 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-black/55 disabled:opacity-50"
            >
              <RotateCw size={13} className={reloading ? 'animate-spin' : ''} />
              <span>{reloading ? t('terminal.restarting') : t('terminal.resume')}</span>
            </button>
          </div>
        )}
        {/* The keyboard is going nowhere. A BAND, not an overlay: the pane stays
            readable and clickable underneath (the scrollback is exactly what
            you want to read while the bridge is down), and it leaves on its own
            at the first byte the bridge delivers. No button: there is nothing
            to retry here, the reconnection is the server's own loop. */}
        {inputDropped && !stale && (
          <div
            data-testid="terminal-input-dropped"
            className="absolute top-0 left-0 right-0 z-20 pointer-events-none flex items-center justify-center gap-2 px-3 py-1.5 bg-amber-500 text-white text-[11px] font-medium"
          >
            <AlertTriangle size={12} />
            <span>{t('terminal.inputDropped')}</span>
          </div>
        )}
        {/* "Ricarica" restart in progress — a clear overlay instead of the bare
            grey gap while the PTY is killed and re-spawned (claude/codex --resume
            boot). Cleared on WS reconnect (ws.onopen) or a safety timeout. */}
        {reloading && !stale && (
          <div data-testid="terminal-reloading-overlay" className="absolute inset-0 flex items-center justify-center bg-surface/80 z-20">
            <div className="flex items-center gap-2 text-app-text-muted text-[12px]">
              <RotateCw size={14} className="animate-spin" />
              <span>{t('terminal.restartingSession')}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
