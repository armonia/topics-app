import {
  app, BrowserWindow, BrowserView, WebContentsView, ipcMain, Menu, Tray,
  nativeImage, shell, session, Notification, globalShortcut,
  type NativeImage, type MenuItemConstructorOptions, type MenuItem,
} from 'electron';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import WebSocket from 'ws';
import { initOverlayManager, showMenu as showOverlayMenu } from './overlay-manager';

// Per-region native vibrancy addon (macOS). Loaded defensively: any failure
// (non-mac, missing/incompatible binary) yields a no-op so the app still boots
// and floating-splits falls back to a CSS surface. See native/vibrancy/.
interface VibrancyAddon {
  available: boolean;
  setRegions: (handle: Buffer, rects: unknown[], material?: string) => number;
  clear: (handle: Buffer) => void;
}
const vibrancy: VibrancyAddon = (() => {
  try {
    // __dirname is dist/ at runtime; the addon lives at electron-app/native/vibrancy.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.join(__dirname, '..', 'native', 'vibrancy')) as VibrancyAddon;
  } catch {
    return { available: false, setRegions: () => 0, clear: () => {} };
  }
})();

// ============ Types ============

interface BrowserTab {
  view: BrowserView;
  url: string;
  title: string;
  visible: boolean;
}

interface TrayIcons {
  normal: NativeImage;
  unread: NativeImage;
  disconnected: NativeImage;
}

interface TrayState {
  gatewayConnected: boolean;
  agentCount: number;
  unread: Map<string, { unreadCount: number }>;
  topics: Map<string, { id: string; name: string; color: string; icon: string }>;
  focusedTopicId: string | null;
  // Per-session previous status, keyed by session.key. Drives `active→idle`
  // detection for the "Agent completed" desktop notification. The server
  // emits status `idle` (after a 30s grace) — NOT `completed` — so the old
  // count-based check missed every transition. We mirror the client's logic.
  prevSessionStatusByKey: Map<string, string>;
  // Per-Claude-session lifecycle phase (chat topics + claude-code terminals),
  // keyed by the session's stable id (sessionKey for chats, else csid). Feeds
  // the menu-bar status glyph (loading / pending-question / error) and the
  // tray menu's Claude section. Resting/finished phases are pruned out.
  claudePhaseBySession: Map<string, ClaudeSessionEntry>;
  // Previous phase per session for transition→notification edge detection
  // (mirrors prevSessionStatusByKey, for the session:state stream).
  prevClaudePhaseBySession: Map<string, string>;
}

interface Preferences {
  alwaysOnTop?: boolean;
  [key: string]: unknown;
}

interface NotificationEntry {
  notification: Notification;
  createdAt: number;
}

interface WSMessage {
  type: string;
  data?: Record<string, { unreadCount: number }>;
  topicId?: string;
  unreadCount?: number;
  connected?: boolean;
  sessions?: Array<{ id: string; key?: string; status: string; agent_id?: string; agentId?: string; topic_id?: string; topicId?: string }>;
  sessionKey?: string;
  message?: { content?: string; text?: string };
  toolName?: string;
  tool_name?: string;
  topic_id?: string;
  // `message:new` envelope (server-side: topics.ts:801, 1354, 1544, 1724, …)
  role?: string;
  content?: string;
  preview?: string;
  messageId?: string;
  // `session:state` envelope (server: claude-session-tracker.ts:197). The
  // Claude Code lifecycle phase of one chat / claude-code terminal session.
  // sessionKey is `topic:<id>` for chats, null for topic-less terminals.
  state?: {
    phase?: string;
    sessionKey?: string | null;
    claudeSessionId?: string;
    error?: { code?: string; message?: string } | null;
    pendingApproval?: { kind?: string; prompt?: string } | null;
  };
}

// Claude lifecycle phases as classified for the tray. Kept as plain strings
// (the canonical enum lives in server/lib/claude-session-state.ts); we only
// need the buckets that drive the menu-bar status glyph.
const CLAUDE_WORKING_PHASES = new Set(['running', 'tool-running']);
const CLAUDE_PENDING_PHASES = new Set(['awaiting-approval', 'paused']);
const CLAUDE_ERROR_PHASES = new Set(['error']);
// Phases a session can rest at without needing the user's eyes — dropped from
// the per-session map so the aggregate counts don't leak completed work.
const CLAUDE_GONE_PHASES = new Set(['completed', 'dormant']);

interface ClaudeSessionEntry {
  phase: string;
  topicId: string | null;
  csid: string;
}

interface NotificationOptions {
  id?: string;
  title: string;
  body: string;
  topicId?: string;
}

// ============ Globals ============

// For self-signed TLS certs on localhost
const httpAgent = new https.Agent({ rejectUnauthorized: false });

function serverGet(urlPath: string, callback: (res: http.IncomingMessage) => void) {
  const url = new URL(urlPath, SERVER_URL || 'https://127.0.0.1:3333');
  const mod = url.protocol === 'https:' ? https : http;
  return mod.get(url.href, { agent: url.protocol === 'https:' ? httpAgent : undefined }, callback);
}

function serverRequest(urlPath: string, options: http.RequestOptions = {}) {
  const url = new URL(urlPath, SERVER_URL || 'https://127.0.0.1:3333');
  const mod = url.protocol === 'https:' ? https : http;
  return mod.request(url.href, { ...options, agent: url.protocol === 'https:' ? httpAgent : undefined });
}

let mainWindow: BrowserWindow | null = null;
// Tracks the main window's full-screen state. In full-screen the traffic
// lights are the only way out, so we keep them visible (and make the
// hide-on-leave-menu IPC a no-op) until the user leaves full-screen.
let mainWindowFullScreen = false;
let tray: Tray | null = null;
let updateLayout: (() => void) | null = null;
let alwaysOnTop = false;

// Preferences file for persistent state
const prefsPath = path.join(app.getPath('userData'), 'preferences.json');

function loadPreferences(): Preferences {
  try {
    if (fs.existsSync(prefsPath)) {
      return JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    }
  } catch (e: unknown) {
    console.error('[Topics Electron] Failed to load preferences:', (e as Error).message);
  }
  return {};
}

function savePreferences(prefs: Partial<Preferences>): void {
  try {
    const existing = loadPreferences();
    fs.writeFileSync(prefsPath, JSON.stringify({ ...existing, ...prefs }, null, 2));
  } catch (e: unknown) {
    console.error('[Topics Electron] Failed to save preferences:', (e as Error).message);
  }
}

function toggleAlwaysOnTop(force?: boolean): void {
  alwaysOnTop = force !== undefined ? force : !alwaysOnTop;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }
  savePreferences({ alwaysOnTop });
  rebuildTrayMenu();
  createAppMenu();
}

// Multi-window support: detached topic windows
const detachedWindows = new Map<string, BrowserWindow>();

// Browser tabs management
const browserTabs = new Map<string, BrowserTab>();
let activeTabId: string | null = null;
let browserPanelVisible = false;
const browserPanelWidth = 0.4;

// Server URL - use DEV_URL env var for hot reload development.
// 127.0.0.1 (NOT localhost): on macOS `localhost` resolves to BOTH ::1 (IPv6)
// and 127.0.0.1 (IPv4); page loads do Happy-Eyeballs fallback but the in-app
// WebSocket does NOT, so if anything else holds :3333 on IPv6 (e.g. another
// project's dev server squatting the port) the page loads but the WS stays
// stuck "connecting". Pinning to IPv4 removes the ambiguity. The dev cert's SAN
// includes 127.0.0.1, and the app bypasses cert errors anyway.
const SERVER_URL = process.env.DEV_URL || 'https://127.0.0.1:3333';
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// CDP port for browser control (Electron DevTools)
const CDP_PORT = 19333;
const CDP_INFO_PORT = 19334;

// Generate unique tab ID
let tabIdCounter = 0;
function generateTabId(): string {
  return `tab-${++tabIdCounter}-${Date.now()}`;
}

// ============ Phase 30.1 BROWSER-CHAT-06 — Native Browser Manager ============
//
// Per-topic WebContentsView lifecycle. Runs alongside (NOT replacing) the
// legacy `browserTabs` Map (BrowserView side-panel — unused in current UI
// but preserved for /json/list backward-compat).
//
// Sync utente↔agent: ONE WebContentsView per topic. Server-side agent
// dispatcher attacca via CDP a porta 19333 (already exposed via
// app.commandLine.appendSwitch line ~1515) e identifica la view via
// `cdpTargetId` ritornato da getCdpTargetId().

interface NativeBrowserEntry {
  view: WebContentsView;
  topicId: string;
  partitionId: string;
  bounds: { x: number; y: number; width: number; height: number };
  // Cleanup on destroy.
  cleanup: () => void;
}

const nativeBrowsers = new Map<string, NativeBrowserEntry>();

// Phase 30.1 polish — pending destroy timers keyed by viewId. Used to
// implement a grace period: the renderer's destroy IPC schedules a
// timeout instead of destroying immediately. If a `create` for the same
// topicId arrives before the timer fires (= remount during DnD), the
// timer is cancelled and the existing view is reused. Prevents glitches
// during tab drag-and-drop, fast tab switch, and React Strict Mode
// double-mount cycles.
const pendingDestroys = new Map<string, ReturnType<typeof setTimeout>>();
const DESTROY_GRACE_MS = 500;

function generateNativeViewId(): string {
  return `nbv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the CDP targetId of a WebContentsView's webContents.
 *
 * Electron exposes CDP on port 19333 (see app.commandLine line ~1515).
 * Each WebContents has a `getOSProcessId()` and a `webContents.id` (renderer
 * process id, NOT CDP targetId). To resolve the actual CDP targetId we hit
 * /json/list and match by URL + title.
 *
 * Match strategy (in order, first non-empty match wins):
 *   1. URL exact match (rare collisions across views)
 *   2. URL prefix match (covers query-string-only nav)
 *   3. Title match (final fallback)
 *
 * Caller MUST ensure the view has finished loading at least once before
 * calling — otherwise URL is 'about:blank' and matches non-deterministically.
 */
async function resolveCdpTargetIdForView(view: WebContentsView): Promise<string> {
  const wc = view.webContents;
  const url = wc.getURL();
  const title = wc.getTitle();

  // 3s timeout so a wedged CDP endpoint can't hang browser-native:create
  // indefinitely — the caller tolerates an empty cdpTargetId on failure.
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) {
    throw new Error(`CDP /json/list returned ${res.status}`);
  }
  const targets = (await res.json()) as Array<{
    id: string;
    type: string;
    url: string;
    title: string;
  }>;

  // 1. URL exact
  const exact = targets.find(t => t.type === 'page' && t.url === url);
  if (exact) return exact.id;

  // 2. URL prefix (strip query+hash for stability)
  const stripped = url.split('?')[0].split('#')[0];
  const prefix = targets.find(t => t.type === 'page' && t.url.startsWith(stripped));
  if (prefix) return prefix.id;

  // 3. Title fallback
  const byTitle = targets.find(t => t.type === 'page' && t.title === title && title !== '');
  if (byTitle) return byTitle.id;

  throw new Error(
    `resolveCdpTargetIdForView: no CDP target match for url=${url} title=${title} (targets seen: ${targets.length})`
  );
}

// Native-browser permission requests awaiting a user decision in the renderer
// permission bar, keyed by requestId → the setPermissionRequestHandler callback.
// Sensitive permissions (camera/mic/geo/display-capture) are default-DENIED and
// only granted when the user clicks Allow in the bar — never auto-granted.
const pendingBrowserPermissions = new Map<string, (granted: boolean) => void>();
let browserPermSeq = 0;
ipcMain.on('browser-native:permission-response', (_e, payload: { requestId?: string; granted?: boolean }) => {
  const settle = payload?.requestId ? pendingBrowserPermissions.get(payload.requestId) : undefined;
  if (settle) settle(Boolean(payload?.granted));
});

function createNativeBrowser(
  topicId: string,
  partitionId: string,
  initialUrl: string
): NativeBrowserEntry {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('createNativeBrowser: mainWindow not available');
  }

  // Per-topic isolated session — cookies/localStorage/sessionStorage scoped
  // to the partition string. Persists across Electron restarts because the
  // 'persist:' prefix tells Electron to write to disk under userData.
  const topicSession = session.fromPartition(partitionId);

  // Phase 30.1 polish — permissions handler. Without this, Chromium
  // silently denies camera/mic/geolocation/notifications/clipboard requests
  // (Electron defaults to deny for child sessions). Forward the prompt to
  // the renderer so the React UI can show a Chrome-style permission bar.
  // For now: auto-allow safe permissions (clipboard read, fullscreen) and
  // forward sensitive ones (camera/mic/geo/notifications) to a renderer
  // dialog via IPC.
  topicSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const safeAllow = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
    const askUser = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture']);

    if (safeAllow.has(permission)) {
      callback(true);
      return;
    }

    if (askUser.has(permission)) {
      // DEFAULT-DENY: never grant camera/mic/geolocation/display-capture without
      // an explicit user click. Forward the request to the renderer permission
      // bar and resolve the callback from its response; fail CLOSED if there is
      // no window or the user doesn't decide in time.
      const url = (details && (details as { requestingUrl?: string }).requestingUrl) || wc.getURL();
      if (!mainWindow || mainWindow.webContents.isDestroyed()) {
        console.warn(`[BrowserNativeManager] Permission '${permission}' denied for ${url} (no window to prompt)`);
        callback(false);
        return;
      }
      const requestId = `perm-${Date.now().toString(36)}-${browserPermSeq++}`;
      let settled = false;
      const settle = (granted: boolean) => {
        if (settled) return;
        settled = true;
        pendingBrowserPermissions.delete(requestId);
        console.log(`[BrowserNativeManager] Permission '${permission}' ${granted ? 'granted' : 'denied'} for ${url} (partition ${partitionId})`);
        callback(granted);
      };
      pendingBrowserPermissions.set(requestId, settle);
      mainWindow.webContents.send('browser-native:permission-request', { requestId, permission, url, partitionId });
      // Fail closed if the user ignores the bar (it also auto-dismisses).
      setTimeout(() => settle(false), 30_000);
      return;
    }

    // Deny anything we don't explicitly understand (defense in depth).
    console.warn(`[BrowserNativeManager] Permission '${permission}' denied (unknown category)`);
    callback(false);
  });

  // Phase 30.1 polish — download manager. Forward each download to the
  // renderer so the user sees a list with pause/resume/cancel/show-in-folder
  // controls. Uses the standard Electron 'will-download' event on the session.
  topicSession.on('will-download', (_e, item) => {
    const id = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const url = item.getURL();
    const filename = item.getFilename();
    const totalBytes = item.getTotalBytes();

    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('browser-native:download-start', { id, url, filename, totalBytes });
    }

    item.on('updated', (_evt, state) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('browser-native:download-progress', {
          id,
          state, // 'progressing' | 'interrupted'
          received: item.getReceivedBytes(),
          total: item.getTotalBytes(),
          isPaused: item.isPaused(),
        });
      }
    });
    item.once('done', (_evt, state) => {
      const savedPath = item.getSavePath();
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('browser-native:download-done', {
          id,
          state, // 'completed' | 'cancelled' | 'interrupted'
          savedPath,
        });
      }
    });
  });

  const view = new WebContentsView({
    webPreferences: {
      session: topicSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // No webview tag in WebContentsView; not needed here.
    },
  });

  // Attach as child of the main window's contentView. The renderer
  // controls placement via setBounds; default starts hidden offscreen
  // until the renderer ResizeObserver fires.
  mainWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  const entry: NativeBrowserEntry = {
    view,
    topicId,
    partitionId,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    cleanup: () => {
      // Listeners are wired below; this is filled in next.
    },
  };

  // Initial navigation — kicks off the page load AFTER attaching to the
  // window so DevTools / CDP picks it up.
  const wc = view.webContents;

  // Phase 30.1 polish — window.open / target=_blank handler. Default
  // Electron action is 'allow' which spawns a NEW BrowserWindow with no
  // chrome — we want links to navigate IN-PLACE so users don't get
  // surprise floating windows when they Cmd+click. Mimics Chrome's
  // "open in new tab" but since Topics has a singleton browser pane per
  // topic, we just navigate the same view. Future: open in a new browser
  // pane (split) when modifier keys requested.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
      // Same-pane navigation — keep the user inside Topics.
      wc.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    }
    // For 'save-to-disk', 'other', etc., let Electron handle it (default
    // is 'deny' but the original URL stays in scope).
    return { action: 'deny' };
  });
  if (initialUrl && initialUrl !== 'about:blank') {
    wc.loadURL(initialUrl).catch((err: unknown) => {
      console.error(`[BrowserNativeManager] initial loadURL failed:`, err);
    });
  } else {
    wc.loadURL('about:blank').catch(() => { /* ignore */ });
  }

  return entry;
}

function destroyNativeBrowser(viewId: string): void {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) return;

  // Run cleanup hooks FIRST (removes IPC senders, listeners, etc.).
  try { entry.cleanup(); } catch (err) {
    console.error(`[BrowserNativeManager] cleanup hook failed for ${viewId}:`, err);
  }

  // Detach from window contentView.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.contentView.removeChildView(entry.view);
    } catch (err) {
      console.error(`[BrowserNativeManager] removeChildView failed for ${viewId}:`, err);
    }
  }

  // Destroy underlying webContents.
  const wc = entry.view.webContents;
  if (!wc.isDestroyed()) {
    // No public destroy() on WebContents; close() works for owned views.
    try {
      (wc as unknown as { close(): void }).close();
    } catch (err) {
      console.error(`[BrowserNativeManager] webContents close failed for ${viewId}:`, err);
    }
  }

  nativeBrowsers.delete(viewId);
}

// ============ Window Management ============

let screenWatchRegistered = false;

// Keep the main window on a CONNECTED display. When a monitor it lived on is
// unplugged or sleeps, macOS leaves the window at coordinates no visible display
// covers, so it vanishes ("I don't see the windows"). Re-centre it on the
// primary display's work area when its centre is off every screen.
function ensureWindowOnScreen(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  try {
    const { screen } = require('electron') as typeof import('electron');
    const b = win.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const onScreen = screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height;
    });
    if (onScreen) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.min(b.width, wa.width);
    const height = Math.min(b.height, wa.height);
    win.setBounds({
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2),
      width,
      height,
    });
    if (!win.isVisible()) win.show();
    win.focus();
    console.log('[Topics Electron] Main window was off-screen — recentred on the primary display');
  } catch (err) {
    console.warn('[Topics Electron] ensureWindowOnScreen failed:', err);
  }
}

// A macOS vibrancy window (floating-splits enables `vibrancy`) can stop
// compositing its web content after a display reconfiguration: the window shows
// ONLY the vibrancy material, which looks like empty / black panes even though
// the renderer is still painting normally (confirmed 2026-06-22 via CDP — the
// DOM was full while the on-screen window was blank; the window had been
// stranded at a negative y after a display change). ensureWindowOnScreen alone
// doesn't fix it: the window's centre can still land on a (secondary/stale)
// display, so the off-screen recentre is a no-op AND the surface never
// re-presents. Re-centre if needed, THEN force the window server to re-present
// the content surface with a 1px bounds bounce — the exact recovery that worked
// when done by hand (move on-screen + resize).
function recomposeWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  ensureWindowOnScreen(win);
  try {
    const b = win.getBounds();
    win.setBounds({ ...b, height: Math.max(1, b.height - 1) });
    setTimeout(() => { if (win && !win.isDestroyed()) win.setBounds(b); }, 60);
  } catch (err) {
    console.warn('[Topics Electron] recomposeWindow failed:', err);
  }
}

function createWindow(): void {
  console.log('[Topics Electron] Creating main window...');
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    // When the per-region vibrancy addon is available we make the window truly
    // TRANSPARENT so floating-splits gaps reveal the clear live desktop, and the
    // addon paints frosted NSVisualEffectViews under each panel rect (the
    // renderer streams them; #root rounds its own corners since a transparent
    // window has no native frame). If the addon isn't available (build missing /
    // older macOS) we fall back to whole-window vibrancy — solid, frosted gaps.
    ...(isMac
      ? (vibrancy.available
          ? { transparent: true as const, roundedCorners: true as const }
          : { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const })
      : {}),
    backgroundColor: isMac ? '#00000000' : '#1a1a1a',
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
    show: false,
  });

  // Phase G · re-pin the traffic-light position on every relevant
  // window event so it doesn't drift on full-screen / restore /
  // resize. The reference desktop client we studied does this on 10+
  // events; we cover the same set.
  if (isMac && mainWindow) {
    const repin = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try { mainWindow.setWindowButtonPosition?.({ x: 12, y: 12 }); } catch {}
    };
    const events = [
      'enter-full-screen', 'leave-full-screen',
      'maximize', 'unmaximize', 'restore', 'show', 'focus', 'resize',
    ] as const;
    for (const evt of events) mainWindow.on(evt as any, repin);
    mainWindow.webContents.on('did-finish-load', repin);
    mainWindow.webContents.on('did-navigate-in-page', repin);
    mainWindow.webContents.on('dom-ready', repin);

    // Full-screen: the title bar is hidden and the traffic lights are
    // normally only shown on demand (Topics menu). In full-screen that
    // leaves no visible way to exit, so force the buttons visible while
    // full-screen and restore the on-demand behaviour on leave.
    mainWindow.on('enter-full-screen', () => {
      mainWindowFullScreen = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setWindowButtonVisibility(true);
    });
    mainWindow.on('leave-full-screen', () => {
      mainWindowFullScreen = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setWindowButtonVisibility(false);
    });
  }

  // Intercept navigation: allow localhost, open external URLs in system browser
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://localhost') || url.startsWith(SERVER_URL)) return;
    event.preventDefault();
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url).catch((err) => {
        console.error('[Topics Electron] Failed to open external URL:', url, err);
      });
    }
  });

  // Hide traffic lights by default — shown on hover via IPC
  mainWindow.setWindowButtonVisibility(false);

  // Layout function for browser panel tabs
  updateLayout = () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();

    if (browserPanelVisible && activeTabId && browserTabs.has(activeTabId)) {
      const topicsWidth = Math.floor(width * (1 - browserPanelWidth));
      mainWindow.webContents.send('browser-panel-layout', { topicsWidth, totalWidth: width });

      for (const [id, tab] of browserTabs) {
        if (id === activeTabId) {
          tab.view.setBounds({ x: topicsWidth, y: 0, width: width - topicsWidth, height });
        } else {
          tab.view.setBounds({ x: width + 1000, y: 0, width: 0, height: 0 });
        }
      }
    } else {
      mainWindow.webContents.send('browser-panel-layout', { topicsWidth: null, totalWidth: width });
      for (const [, tab] of browserTabs) {
        tab.view.setBounds({ x: (mainWindow?.getSize()[0] ?? 0) + 1000, y: 0, width: 0, height: 0 });
      }
    }
  };

  mainWindow.on('resize', updateLayout);

  // Phase 30.1 polish — re-fire layout updates on display moves and
  // minimize/restore/show/hide so native WebContentsViews follow the
  // window correctly. Without this, a minimized window can "leak" the
  // browser pane fixed at its last bounds, and dragging the window
  // between displays with different scaleFactor causes misalignment.
  const refireLayoutEvents: string[] = [
    'minimize', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen',
    'move', 'moved', 'show', 'hide',
  ];
  for (const evt of refireLayoutEvents) {
    try {
      mainWindow.on(evt as never, () => {
        // Notify the renderer so its ResizeObserver/poll re-issues setBounds
        // for every native browser view. Cheap signal — no payload needed.
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('browser-native:reflow');
        }
      });
    } catch {
      // Some events not supported on all platforms — ignore.
    }
  }

  // Show a branded loading page IMMEDIATELY, then poll the server and switch to
  // the real app once it responds. WHY: the window is `show:false` and used to
  // be revealed ONLY on the app's `did-finish-load`. If the bundled server was
  // slow — or never started (e.g. its unsigned binaries got Gatekeeper-blocked
  // on a freshly-downloaded app) — that event never fired and the window stayed
  // hidden forever: the app "didn't open" and, with no visible window, felt
  // impossible to quit. Now a window is always on screen within a second, the
  // poller connects when the server is ready, and the tray (created right after
  // this) is always there to Quit.
  const LOADING_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><style>
      html,body{height:100%;margin:0}
      body{background:#16181d;color:#e7e7ea;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none}
      .spin{width:26px;height:26px;border:2.5px solid rgba(255,255,255,.15);border-top-color:#d97757;
        border-radius:50%;animation:s .8s linear infinite}
      @keyframes s{to{transform:rotate(360deg)}}
      .t{font-weight:600;letter-spacing:.2px}.d{color:#9b9ba3;font-size:12.5px}
      .hint{color:#9b9ba3;font-size:12px;max-width:320px;text-align:center;opacity:0;transition:opacity .4s}
    </style>
    <div class="spin"></div>
    <div class="t">Starting Topics…</div>
    <div class="d">Launching the local engine</div>
    <div class="hint" id="h">This is taking longer than usual. You can always quit from the Topics icon in the menu bar.</div>
    <script>setTimeout(function(){document.getElementById('h').style.opacity=1},15000)</script>`
  );

  let appLoaded = false;
  mainWindow.loadURL(LOADING_PAGE).catch(() => { /* data URL never fails */ });
  mainWindow.show(); // visible right away, regardless of server state
  // Startup safety: if the window was restored / placed at coordinates no
  // connected display covers (e.g. a monitor that was present last run is now
  // gone), recentre it onto the primary display immediately rather than waiting
  // for a display event.
  ensureWindowOnScreen(mainWindow);

  // Recover the window when the display layout changes (unplug / sleep / connect
  // / resolution or scale change) — macOS would otherwise strand it off-screen
  // OR leave a vibrancy window showing only its blur material (blank panes).
  // recomposeWindow re-centres if needed AND forces the content surface to
  // re-present. Registered once (guarded) since the screen module is
  // process-global.
  if (!screenWatchRegistered) {
    screenWatchRegistered = true;
    const { screen, powerMonitor } = require('electron') as typeof import('electron');
    const onRecompose = () => recomposeWindow(mainWindow);
    screen.on('display-removed', onRecompose);
    screen.on('display-added', onRecompose);
    screen.on('display-metrics-changed', onRecompose);
    // The most common trigger of the blank-vibrancy-window is the Mac (or just a
    // monitor) sleeping and waking: macOS drops the window's content surface on
    // sleep, and a plain wake neither re-presents it nor reliably fires a
    // display event. Recompose on power resume + screen unlock too.
    powerMonitor.on('resume', onRecompose);
    powerMonitor.on('unlock-screen', onRecompose);
  }
  // Re-present the surface whenever the window is shown again (restored from the
  // tray, or re-shown after being hidden during sleep). Registered after the
  // initial show() above, so it only fires on LATER shows.
  mainWindow.on('show', () => recomposeWindow(mainWindow));

  const connectWhenReady = async () => {
    if (!mainWindow || mainWindow.isDestroyed() || appLoaded) return;
    if (await serverAlreadyUp(1000)) {
      appLoaded = true;
      mainWindow.loadURL(SERVER_URL).catch((err: { code?: string; errno?: number }) => {
        // ERR_ABORTED (-3) just means a newer navigation superseded this load
        // (e.g. it replaced the still-loading splash) — not a real failure, so
        // don't bounce back to the splash and retry.
        if (err && (err.code === 'ERR_ABORTED' || err.errno === -3)) return;
        console.error('[Topics Electron] app load failed, retrying:', err);
        appLoaded = false;
        setTimeout(connectWhenReady, 600);
      });
      return;
    }
    setTimeout(connectWhenReady, 600);
  };
  void connectWhenReady();

  // Phase 30.1 polish — destroy orphan native browsers on renderer reload.
  // When the React app hot-reloads (Vite HMR, Cmd+R, dev server restart),
  // the React tree unmounts but the WebContentsView attached to mainWindow
  // stays alive (no IPC destroy fires in time), causing it to occupy
  // viewport space without a controlling React component. The renderer
  // then re-mounts the hook with a NEW viewId, so the old view becomes
  // orphan + visible. Solution: on every did-finish-load AFTER the first
  // (= renderer reloaded), destroy all currently-tracked native views.
  let firstLoadHandled = false;
  mainWindow.webContents.on('did-finish-load', () => {
    if (!firstLoadHandled) {
      firstLoadHandled = true;
      return;
    }
    if (nativeBrowsers.size > 0) {
      console.log(`[BrowserNativeManager] Renderer reloaded — destroying ${nativeBrowsers.size} orphan view(s)`);
      const orphanIds = Array.from(nativeBrowsers.keys());
      for (const viewId of orphanIds) {
        try { destroyNativeBrowser(viewId); } catch (err) {
          console.error(`[BrowserNativeManager] orphan destroy failed for ${viewId}:`, err);
        }
      }
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, failedUrl) => {
    console.error('[Topics Electron] Failed to load:', code, desc, failedUrl);
    // -3 = ERR_ABORTED (a superseded navigation, e.g. our own reload) — ignore.
    if (code === -3) return;
    // The real app URL dropped (server restarted/hiccuped mid-load): fall back
    // to the loading page and resume polling instead of leaving Electron's bare
    // error page, so the window keeps showing a sane state and auto-reconnects.
    if (failedUrl && failedUrl.startsWith(SERVER_URL) && mainWindow && !mainWindow.isDestroyed()) {
      appLoaded = false;
      mainWindow.loadURL(LOADING_PAGE).catch(() => {});
      setTimeout(connectWhenReady, 600);
    }
  });

  mainWindow.on('closed', () => {
    console.log('[Topics Electron] Main window closed');
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    // Detached topic windows (Cmd-click "Pop out" in the chat): explicit
    // intent — open as a separate Electron BrowserWindow inside the app.
    if (frameName && frameName.startsWith('topic-')) {
      const topicId = frameName.replace('topic-', '');
      createDetachedWindow(topicId, url, features);
      return { action: 'deny' as const };
    }

    // Everything else: route to the user's system browser. Previously we
    // allowed http://localhost and the topics server URL to open as native
    // Electron windows, but that meant clicking the port link of a spawned
    // dev server (e.g. localhost:3456 from ScriptRunner) popped a barebones
    // Electron BrowserWindow instead of opening in the user's real browser.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url).catch((err) => {
        console.error('[Topics Electron] Failed to open external URL:', url, err);
      });
    } else {
      console.warn('[Topics Electron] Ignoring non-http URL:', url);
    }
    return { action: 'deny' as const };
  });

  mainWindow.on('close', (e) => {
    if (!(app as unknown as { isQuitting: boolean }).isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
    }
  });
}

function createDetachedWindow(topicId: string, url: string, features = ''): BrowserWindow | undefined {
  console.log('[Topics Electron] Creating detached window for topic:', topicId);

  let width = 900, height = 700;
  if (features) {
    const widthMatch = features.match(/width=(\d+)/);
    const heightMatch = features.match(/height=(\d+)/);
    if (widthMatch) width = parseInt(widthMatch[1]);
    if (heightMatch) height = parseInt(heightMatch[1]);
  }

  if (detachedWindows.has(topicId)) {
    const existing = detachedWindows.get(topicId)!;
    if (!existing.isDestroyed()) {
      existing.focus();
      return existing;
    }
  }

  const detachedWin = new BrowserWindow({
    width,
    height,
    minWidth: 500,
    minHeight: 400,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1a1a1a',
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Hide traffic lights by default — shown on hover via IPC
  detachedWin.setWindowButtonVisibility(false);

  detachedWindows.set(topicId, detachedWin);
  detachedWin.loadURL(url);

  detachedWin.on('closed', () => {
    detachedWindows.delete(topicId);
    console.log('[Topics Electron] Detached window closed for topic:', topicId);
  });

  detachedWin.webContents.on('will-navigate', (event, navUrl) => {
    if (navUrl.startsWith('http://localhost') || navUrl.startsWith(SERVER_URL)) return;
    event.preventDefault();
    if (navUrl.startsWith('https://') || navUrl.startsWith('http://')) {
      shell.openExternal(navUrl).catch((err) => {
        console.error('[Topics Electron] Failed to open external URL:', navUrl, err);
      });
    }
  });

  detachedWin.webContents.setWindowOpenHandler(({ url: newUrl, frameName }) => {
    if (frameName && frameName.startsWith('topic-')) {
      const newTopicId = frameName.replace('topic-', '');
      createDetachedWindow(newTopicId, newUrl);
      return { action: 'deny' as const };
    }
    // Same policy as the main window: every regular link click goes to the
    // system browser, including localhost dev-server URLs.
    if (newUrl.startsWith('https://') || newUrl.startsWith('http://')) {
      shell.openExternal(newUrl).catch((err) => {
        console.error('[Topics Electron] Failed to open external URL:', newUrl, err);
      });
    } else {
      console.warn('[Topics Electron] Ignoring non-http URL:', newUrl);
    }
    return { action: 'deny' as const };
  });

  return detachedWin;
}

// ============ Browser Tabs ============

function createBrowserTab(initialUrl = 'about:blank'): { id: string; url: string; title: string } {
  const id = generateTabId();

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow!.addBrowserView(view);

  const tab: BrowserTab = {
    view,
    url: initialUrl,
    title: 'New Tab',
    visible: false,
  };

  browserTabs.set(id, tab);

  view.webContents.on('did-navigate', (_event, url) => {
    tab.url = url;
    notifyTopics('tab-navigated', { id, url, title: tab.title });
  });

  view.webContents.on('did-navigate-in-page', (_event, url) => {
    tab.url = url;
    notifyTopics('tab-navigated', { id, url, title: tab.title });
  });

  view.webContents.on('page-title-updated', (_event, title) => {
    tab.title = title;
    notifyTopics('tab-title-updated', { id, title, url: tab.url });
  });

  if (initialUrl && initialUrl !== 'about:blank') {
    view.webContents.loadURL(initialUrl);
  }

  return { id, url: tab.url, title: tab.title };
}

function closeBrowserTab(id: string): boolean {
  const tab = browserTabs.get(id);
  if (!tab) return false;

  mainWindow!.removeBrowserView(tab.view);
  (tab.view.webContents as unknown as { destroy(): void }).destroy();
  browserTabs.delete(id);

  if (activeTabId === id) {
    activeTabId = browserTabs.size > 0 ? browserTabs.keys().next().value ?? null : null;
  }

  updateLayout?.();
  return true;
}

function notifyTopics(event: string, data: Record<string, unknown>): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser-event', { event, ...data });
  }
}

// ============ Tray State ============

const trayState: TrayState = {
  gatewayConnected: false,
  agentCount: 0,
  unread: new Map(),
  topics: new Map(),
  focusedTopicId: null,
  prevSessionStatusByKey: new Map(),
  claudePhaseBySession: new Map(),
  prevClaudePhaseBySession: new Map(),
};

let trayIcons: Partial<TrayIcons> = {};

function loadTrayIcons(): void {
  const baseIcon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png')).resize({ width: 18, height: 18 });
  baseIcon.setTemplateImage(true);

  trayIcons = {
    normal: baseIcon,
    unread: baseIcon,
    disconnected: baseIcon,
  };
}

// ============ WebSocket Bridge ============

let trayWS: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelay = 1000;
let topicCacheTimer: ReturnType<typeof setInterval> | null = null;
// Log hygiene: during an outage the bridge retries forever; without this it
// logs connecting/error/disconnected on EVERY cycle (the .err file had 800+
// such lines). Log the first failure of an outage once, then go quiet until
// the next successful connect.
let wsOutageLogged = false;

function startWSBridge(): void {
  if (trayWS) return;
  const wsUrl = SERVER_URL.replace(/^http/, 'ws') + '/ws';
  if (!wsOutageLogged) console.log('[Topics Electron] WS bridge connecting to', wsUrl);

  try {
    trayWS = new WebSocket(wsUrl, { rejectUnauthorized: false });
  } catch (err: unknown) {
    if (!wsOutageLogged) { console.error('[Topics Electron] WS bridge connection error:', (err as Error).message); wsOutageLogged = true; }
    scheduleWSReconnect();
    return;
  }

  trayWS.on('open', () => {
    console.log('[Topics Electron] WS bridge connected');
    wsReconnectDelay = 1000;
    wsOutageLogged = false;
    fetchTopicCache();
    // Bootstrap Claude phase from the authoritative snapshot. session:state is
    // transition-only, so without this the tray would show no Claude status
    // until the next phase change — and stale entries from before a reconnect
    // would linger. Re-fetching on every (re)connect makes it self-healing.
    fetchClaudeSessions();
    if (topicCacheTimer) clearInterval(topicCacheTimer);
    topicCacheTimer = setInterval(fetchTopicCache, 60000);
  });

  trayWS.on('message', (data) => {
    try {
      const msg: WSMessage = JSON.parse(data.toString());
      handleWSMessage(msg);
    } catch (_e) { /* ignore parse errors */ }
  });

  trayWS.on('close', () => {
    if (!wsOutageLogged) { console.log('[Topics Electron] WS bridge disconnected'); wsOutageLogged = true; }
    trayWS = null;
    scheduleWSReconnect();
  });

  trayWS.on('error', (err) => {
    if (!wsOutageLogged) { console.error('[Topics Electron] WS bridge error:', err.message); wsOutageLogged = true; }
    if (trayWS) { try { trayWS.close(); } catch (_e) { /* ignore */ } }
    trayWS = null;
    scheduleWSReconnect();
  });
}

function scheduleWSReconnect(): void {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
    startWSBridge();
  }, wsReconnectDelay);
}

function stopWSBridge(): void {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (topicCacheTimer) { clearInterval(topicCacheTimer); topicCacheTimer = null; }
  if (trayWS) { try { trayWS.close(); } catch (_e) { /* ignore */ } trayWS = null; }
}

function handleWSMessage(msg: WSMessage): void {
  switch (msg.type) {
    case 'unread:init':
      trayState.unread.clear();
      if (msg.data) {
        for (const [topicId, info] of Object.entries(msg.data)) {
          if (info && info.unreadCount > 0) {
            trayState.unread.set(topicId, { unreadCount: info.unreadCount });
          }
        }
      }
      onStateChanged();
      break;

    case 'unread:updated':
      if (msg.unreadCount! > 0) {
        trayState.unread.set(msg.topicId!, { unreadCount: msg.unreadCount! });
      } else {
        trayState.unread.delete(msg.topicId!);
      }
      onStateChanged();
      break;

    case 'gateway:status': {
      const wasConnected = trayState.gatewayConnected;
      trayState.gatewayConnected = !!msg.connected;
      if (wasConnected !== trayState.gatewayConnected) {
        notifyGatewayStatus(trayState.gatewayConnected);
      }
      onStateChanged();
      break;
    }

    case 'agents:sessions':
      if (Array.isArray(msg.sessions)) {
        trayState.agentCount = msg.sessions.filter(s => s.status === 'active').length;

        // Detect per-session active→idle transitions. The server's
        // `deriveStatus()` returns 'active' while a session is producing
        // output and flips to 'idle' once 30s have elapsed without activity
        // (see server/routes/agents.ts). That edge is the real "agent
        // finished" signal — the previous count-based heuristic misfired.
        const prev = trayState.prevSessionStatusByKey;
        const next = new Map<string, string>();
        for (const session of msg.sessions) {
          // The server emits `key` on every session (`agentId:topicId`); the
          // older `id` is kept as a fallback so this still works against a
          // gateway that hasn't shipped the field yet.
          const sessionKey = session.key || session.id;
          if (!sessionKey) continue;
          const previousStatus = prev.get(sessionKey);
          const justCompleted = previousStatus === 'active' && session.status === 'idle';
          const justErrored = session.status === 'error' && previousStatus !== 'error';
          if (justCompleted || justErrored) {
            notifyAgentCompleted(session);
          }
          next.set(sessionKey, session.status);
        }
        trayState.prevSessionStatusByKey = next;
      }
      onStateChanged();
      break;

    case 'session:state':
      handleClaudeSessionState(msg);
      break;

    case 'message':
      // Legacy/sync path (topics.ts:1353 etc.). Kept for compatibility; the
      // hot path for AI replies is `message:new` below.
      if (msg.sessionKey && msg.message) {
        handleNewMessage(msg);
      }
      break;

    case 'message:new':
      // Server broadcasts this for every stored message (user + assistant).
      // Only badge the user on assistant replies — echoing their own messages
      // back as desktop notifs would be noise.
      if (msg.role === 'assistant' && msg.topicId) {
        handleNewMessage(msg);
      }
      break;

    case 'approval:created':
      notifyApproval(msg);
      break;

    case 'agent:escalation':
      notifyAgentEscalation(msg);
      break;

    case 'agent:nudge':
      notifyAgentNudge(msg);
      break;

    case 'task:created': {
      // Only desktop-notify on tasks autonomously created by agents — user
      // self-added todos already echo on the UI they were typed into.
      const t = (msg as unknown as { task?: { assignedAgentId?: string | null } }).task;
      if (t && t.assignedAgentId) {
        notifyAgentTaskCreated(msg);
      }
      break;
    }

    case 'pong':
      break;
  }
}

// ============ Topic Cache ============

function fetchTopicCache(): void {
  const req = serverGet('/api/topics', (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const topicsMap = json.topics || json;
        trayState.topics.clear();
        for (const [id, t] of Object.entries(topicsMap) as [string, Record<string, string>][]) {
          if (t && !(t as Record<string, unknown>).archived) {
            trayState.topics.set(id, { id, name: t.name, color: t.color, icon: t.icon });
          }
        }
        scheduleTrayMenuRebuild();
      } catch (_e) { /* ignore parse errors */ }
    });
  });
  req.on('error', () => {});
}

function getTopicName(topicId: string): string {
  const topic = trayState.topics.get(topicId);
  if (topic) return topic.name;
  fetchTopicCache();
  return topicId;
}

// ============ Claude Session Snapshot ============

/**
 * Rebuild the Claude phase map from the server's authoritative snapshot.
 * Called on every WS (re)connect: drops stale entries (sessions that ended
 * while we were disconnected) and seeds prev-phase so we don't re-notify for
 * states that were already true before we connected.
 */
function fetchClaudeSessions(): void {
  const req = serverGet('/api/claude-sessions', (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const sessions: Array<Record<string, unknown>> = Array.isArray(json.sessions) ? json.sessions : [];
        trayState.claudePhaseBySession.clear();
        for (const s of sessions) {
          const phase = typeof s.phase === 'string' ? s.phase : null;
          if (!phase || CLAUDE_GONE_PHASES.has(phase)) continue;
          const sessionKey = typeof s.sessionKey === 'string' ? s.sessionKey : null;
          const csid = typeof s.claudeSessionId === 'string' ? s.claudeSessionId : '';
          const key = sessionKey || csid;
          if (!key) continue;
          const topicId = topicIdFromSessionKey(sessionKey);
          trayState.claudePhaseBySession.set(key, { phase, topicId, csid: csid || key });
          // Seed prev-phase: a state already true at connect time must not fire
          // a fresh desktop notification.
          trayState.prevClaudePhaseBySession.set(key, phase);
        }
        scheduleTrayMenuRebuild();
      } catch (_e) { /* ignore parse errors */ }
    });
  });
  req.on('error', () => {});
}

// ============ Dynamic Tray Menu ============

let menuRebuildTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTrayMenuRebuild(): void {
  if (menuRebuildTimer) return;
  menuRebuildTimer = setTimeout(() => {
    menuRebuildTimer = null;
    rebuildTrayMenu();
    updateTrayIcon();
    updateDockBadge();
  }, 1000);
}

function onStateChanged(): void {
  scheduleTrayMenuRebuild();
}

function rebuildTrayMenu(): void {
  if (!tray) return;

  const appLabel = isDev ? 'Topics DEV' : 'Topics';
  const items: MenuItemConstructorOptions[] = [];

  items.push({
    label: trayState.gatewayConnected ? 'Gateway: Connected  \u2713' : 'Gateway: Disconnected  \u2717',
    enabled: false,
  });

  if (trayState.agentCount > 0) {
    items.push({ label: `Agents: ${trayState.agentCount} active`, enabled: false });
  }

  // Claude chat status — loading / pending-question / error. The icon + title
  // carry the at-a-glance signal; this section names the specific chats so the
  // user can jump straight to the one that needs them.
  const claude = deriveClaudeAggregate();
  if (claude.working || claude.pending || claude.error) {
    items.push({ type: 'separator' });
    const summary: string[] = [];
    if (claude.error) summary.push(`${claude.error} error${claude.error > 1 ? 's' : ''}`);
    if (claude.pending) summary.push(`${claude.pending} awaiting you`);
    if (claude.working) summary.push(`${claude.working} working`);
    items.push({ label: `Claude: ${summary.join('  ·  ')}`, enabled: false });
    for (const a of claude.attention.slice(0, 8)) {
      if (!a.topicId) continue;
      const tag = CLAUDE_ERROR_PHASES.has(a.phase) ? '⚠️' : '❓';
      const tid = a.topicId;
      items.push({ label: `  ${tag} ${getTopicName(tid)}`, click: () => navigateToTopic(tid) });
    }
  }

  const unreadTopics: { topicId: string; unreadCount: number; name: string }[] = [];
  for (const [topicId, info] of trayState.unread) {
    unreadTopics.push({ topicId, unreadCount: info.unreadCount, name: getTopicName(topicId) });
  }
  unreadTopics.sort((a, b) => b.unreadCount - a.unreadCount);

  if (unreadTopics.length > 0) {
    items.push({ type: 'separator' });
    for (const topic of unreadTopics.slice(0, 10)) {
      items.push({
        label: `${topic.name} (${topic.unreadCount})`,
        click: () => navigateToTopic(topic.topicId),
      });
    }
    items.push({ type: 'separator' });
    items.push({
      label: 'Mark All Read',
      click: () => markAllRead(),
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Always on Top',
    type: 'checkbox',
    checked: alwaysOnTop,
    click: () => toggleAlwaysOnTop(),
  });
  items.push({
    label: 'Open at Login',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (menuItem: MenuItem) => {
      app.setLoginItemSettings({ openAtLogin: menuItem.checked });
    },
  });
  items.push({ label: `Show ${appLabel}`, click: () => { mainWindow?.show(); mainWindow?.focus(); } });
  items.push({ label: 'Quit', click: () => { (app as unknown as { isQuitting: boolean }).isQuitting = true; app.quit(); } });

  const contextMenu = Menu.buildFromTemplate(items);
  tray.setContextMenu(contextMenu);

  const totalUnread = getTotalUnread();
  const tipParts: string[] = [];
  if (claude.error) tipParts.push(`⚠️ ${claude.error}`);
  if (claude.pending) tipParts.push(`❓ ${claude.pending}`);
  if (claude.working) tipParts.push(`⏳ ${claude.working}`);
  if (totalUnread > 0) tipParts.push(`${totalUnread} unread`);
  tray.setToolTip(tipParts.length ? `${appLabel} — ${tipParts.join('  ·  ')}` : appLabel);
}

function getTotalUnread(): number {
  let total = 0;
  for (const info of trayState.unread.values()) {
    total += info.unreadCount;
  }
  return total;
}

// ============ Dynamic Tray Icon ============

function updateTrayIcon(): void {
  if (!tray || !trayIcons.normal) return;

  const totalUnread = getTotalUnread();
  const agg = deriveClaudeAggregate();
  const glyph = claudeStatusGlyph(agg);
  const hasAttention = glyph !== '' || totalUnread > 0;

  // Icon: attention variant when anything wants the user (unread OR a Claude
  // chat pending/errored), disconnected when the gateway is down, else normal.
  if (hasAttention) {
    tray.setImage(trayIcons.unread!);
  } else if (!trayState.gatewayConnected) {
    tray.setImage(trayIcons.disconnected!);
  } else {
    tray.setImage(trayIcons.normal);
  }

  // Title: status glyph (⚠️ error / ❓ pending-question) + unread count. The
  // emoji is OS-colored, so error vs pending is distinguishable at a glance
  // even though the menu-bar template icon is monochrome.
  const titleParts: string[] = [];
  if (glyph) titleParts.push(glyph);
  if (totalUnread > 0) titleParts.push(String(totalUnread));
  tray.setTitle(titleParts.join(' '), { fontType: 'monospacedDigit' });
}

function updateDockBadge(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const totalUnread = getTotalUnread();
  const agg = deriveClaudeAggregate();
  if (totalUnread > 0) {
    app.dock.setBadge(String(totalUnread));
  } else if (agg.error > 0 || agg.pending > 0) {
    // Red dock badge for an errored / pending Claude chat even with no unread
    // message count to show.
    app.dock.setBadge('!');
  } else {
    app.dock.setBadge(isDev ? 'DEV' : '');
  }
}

// ============ Mark All Read ============

function markAllRead(): void {
  for (const topicId of trayState.unread.keys()) {
    const req = serverRequest(`/api/topics/${topicId}/read`, { method: 'POST' });
    req.on('error', () => {});
    req.end();
  }
}

// ============ Navigate to Topic ============

function navigateToTopic(topicId: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate-to-topic', topicId);
  }
}

// ============ Notification Manager ============

const activeNotifications = new Map<string, NotificationEntry>();
const notificationCooldowns = new Map<string, number>();
let notificationCleanupTimer: ReturnType<typeof setInterval> | null = null;

function startNotificationCleanup(): void {
  notificationCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of activeNotifications) {
      if (now - entry.createdAt > 5 * 60 * 1000) {
        activeNotifications.delete(id);
      }
    }
  }, 60000);
}

function stopNotificationCleanup(): void {
  if (notificationCleanupTimer) {
    clearInterval(notificationCleanupTimer);
    notificationCleanupTimer = null;
  }
  activeNotifications.clear();
}

function showNotification({ id, title, body, topicId }: NotificationOptions): void {
  if (!Notification.isSupported()) return;

  const notif = new Notification({ title, body, silent: false });
  const notifId = id || `notif-${Date.now()}`;

  activeNotifications.set(notifId, { notification: notif, createdAt: Date.now() });

  notif.on('click', () => {
    activeNotifications.delete(notifId);
    if (topicId) {
      navigateToTopic(topicId);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  notif.on('close', () => {
    activeNotifications.delete(notifId);
  });

  notif.show();
}

function isTopicOnCooldown(topicId: string): boolean {
  const last = notificationCooldowns.get(topicId);
  if (last && Date.now() - last < 10000) return true;
  return false;
}

function setTopicCooldown(topicId: string): void {
  notificationCooldowns.set(topicId, Date.now());
}

/**
 * Topic-scoped desktop-notification gate shared by every notify* path:
 *   - optional focus-suppression (don't notify the chat you're staring at),
 *   - per-topic 10s cooldown (no back-to-back spam on one topic).
 * Centralises the pattern each trigger used to re-implement. Returns true if a
 * notification was actually shown.
 */
function notifyForTopic(opts: {
  topicId: string | null | undefined;
  id: string;
  title: string;
  body: string;
  /** Suppress while the user is focused on this topic. Default true. */
  suppressWhenFocused?: boolean;
}): boolean {
  const { topicId, id, title, body, suppressWhenFocused = true } = opts;
  if (
    suppressWhenFocused && topicId &&
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() &&
    trayState.focusedTopicId === topicId
  ) {
    return false;
  }
  if (topicId) {
    if (isTopicOnCooldown(topicId)) return false;
    setTopicCooldown(topicId);
  }
  showNotification({ id, title, body, topicId: topicId || undefined });
  return true;
}

// ============ Notification Triggers ============

function handleNewMessage(msg: WSMessage): void {
  // Accept both envelopes:
  //  - `message:new`  (hot path) carries `topicId` + `preview`/`content`.
  //  - `message`      (legacy)   carries `sessionKey` + `message.{content,text}`.
  const topicId = msg.topicId || msg.sessionKey?.replace('topic:', '');
  if (!topicId) return;

  const messageText = msg.preview || msg.content || msg.message?.content || msg.message?.text || '';
  const preview = messageText.length > 100 ? messageText.substring(0, 100) + '...' : messageText;

  notifyForTopic({
    topicId,
    id: `msg-${topicId}-${Date.now()}`,
    title: getTopicName(topicId),
    body: preview || 'New message',
  });
}

function notifyAgentCompleted(session: WSMessage['sessions'] extends (infer T)[] | undefined ? T : never): void {
  const topicId = session.topic_id || session.topicId;
  const agentLabel = session.agent_id || session.agentId || 'Agent';
  const topicName = topicId ? getTopicName(topicId) : null;

  // suppressWhenFocused:false — we always fire; focus-suppression for agents is
  // opt-in via a user setting and lives on the renderer side, not here. The
  // per-topic cooldown (inside notifyForTopic) still prevents back-to-back spam.
  notifyForTopic({
    topicId,
    id: `agent-${session.id || topicId || 'x'}-${Date.now()}`,
    title: topicName ? `${topicName} · agent done` : 'Agent completed',
    body: topicName ? agentLabel : `${agentLabel} session finished`,
    suppressWhenFocused: false,
  });
}

// ============ Claude Session Phase (loading / pending-question / error) ============

/** topicId for a session:state frame. Chats key off sessionKey `topic:<id>`;
 *  topic-less claude-code terminals have a null sessionKey. */
function topicIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  return sessionKey.startsWith('topic:') ? sessionKey.slice('topic:'.length) : null;
}

/**
 * Ingest a `session:state` broadcast. Maintains a per-session phase map that
 * drives the menu-bar status glyph (loading / pending-question / error) and
 * the tray menu's Claude section, and fires edge-triggered desktop
 * notifications for the two actionable phases the tray never surfaced before
 * (error, awaiting-approval). Finished/resting phases are pruned so the
 * aggregate counts only reflect work that still wants the user's eyes.
 */
function handleClaudeSessionState(msg: WSMessage): void {
  const state = msg.state;
  if (!state || typeof state.phase !== 'string') return;
  const phase = state.phase;
  // Stable key: chats off sessionKey, terminals off claudeSessionId — mirrors
  // the client's useClaudeSessionState fallback.
  const key = (msg.sessionKey ?? state.sessionKey) || state.claudeSessionId;
  if (!key) return;
  const topicId = topicIdFromSessionKey(msg.sessionKey ?? state.sessionKey);

  const prevPhase = trayState.prevClaudePhaseBySession.get(key);

  if (CLAUDE_GONE_PHASES.has(phase)) {
    // Finished/resting: drop from BOTH maps so neither the aggregate counts nor
    // the prev-phase table leak completed sessions over a long-lived tray.
    trayState.claudePhaseBySession.delete(key);
    trayState.prevClaudePhaseBySession.delete(key);
  } else {
    trayState.claudePhaseBySession.set(key, { phase, topicId, csid: state.claudeSessionId || key });
    trayState.prevClaudePhaseBySession.set(key, phase);
  }

  // Edge-triggered notification. awaiting-user / completed are already covered
  // by the message:new reply notification, so we only add the two states that
  // had no desktop cue: error and awaiting-approval.
  if (phase !== prevPhase) {
    if (CLAUDE_ERROR_PHASES.has(phase)) {
      notifyClaudeSessionState(topicId, 'error', state);
    } else if (phase === 'awaiting-approval') {
      notifyClaudeSessionState(topicId, 'awaiting-approval', state);
    }
  }

  onStateChanged();
}

interface ClaudeAggregate {
  working: number;
  pending: number;
  error: number;
  /** Sessions wanting attention (error + pending), for the menu listing. */
  attention: Array<{ topicId: string | null; phase: string }>;
}

function deriveClaudeAggregate(): ClaudeAggregate {
  let working = 0, pending = 0, error = 0;
  const attention: Array<{ topicId: string | null; phase: string }> = [];
  for (const entry of trayState.claudePhaseBySession.values()) {
    if (CLAUDE_ERROR_PHASES.has(entry.phase)) { error++; attention.push({ topicId: entry.topicId, phase: entry.phase }); }
    else if (CLAUDE_PENDING_PHASES.has(entry.phase)) { pending++; attention.push({ topicId: entry.topicId, phase: entry.phase }); }
    else if (CLAUDE_WORKING_PHASES.has(entry.phase)) { working++; }
  }
  // Errors first, then pending, so the menu lists the loudest items on top.
  attention.sort((a, b) => (CLAUDE_ERROR_PHASES.has(b.phase) ? 1 : 0) - (CLAUDE_ERROR_PHASES.has(a.phase) ? 1 : 0));
  return { working, pending, error, attention };
}

/** Menu-bar status glyph for the most severe Claude state. Empty when nothing
 *  needs the user — "working" lives in the tooltip/menu, not the title, so the
 *  menu bar doesn't flicker on every tool call. */
function claudeStatusGlyph(agg: ClaudeAggregate): string {
  if (agg.error > 0) return '⚠️';
  if (agg.pending > 0) return '❓';
  return '';
}

function notifyClaudeSessionState(
  topicId: string | null,
  phase: 'error' | 'awaiting-approval',
  state: NonNullable<WSMessage['state']>,
): void {
  const label = topicId ? getTopicName(topicId) : 'Claude';
  const csid = state.claudeSessionId || 'x';
  if (phase === 'error') {
    notifyForTopic({
      topicId,
      id: `claude-error-${topicId || csid}-${Date.now()}`,
      title: `⚠️ ${label}`,
      body: state.error?.message || 'La sessione Claude è andata in errore',
    });
  } else {
    notifyForTopic({
      topicId,
      id: `claude-approval-${topicId || csid}-${Date.now()}`,
      title: `❓ ${label}`,
      body: state.pendingApproval?.prompt || 'Claude ha bisogno della tua approvazione',
    });
  }
}

function notifyApproval(msg: WSMessage): void {
  const topicId = msg.topicId || msg.topic_id;
  showNotification({
    id: `approval-${Date.now()}`,
    title: 'Approval needed',
    body: msg.toolName || msg.tool_name || 'Action requires approval',
    topicId,
  });
}

function notifyAgentEscalation(msg: WSMessage): void {
  // Escalation = worker explicitly asking the human for help. Always fires;
  // these are user-attention events by definition.
  const m = msg as unknown as { agentName?: string; message?: string; projectId?: string };
  const name = m.agentName || 'Agent';
  const body = m.message || 'needs your input';
  showNotification({
    id: `escalation-${m.projectId || 'x'}-${Date.now()}`,
    title: `${name} · needs help`,
    body: body.length > 140 ? body.substring(0, 140) + '...' : body,
  });
}

function notifyAgentNudge(msg: WSMessage): void {
  const m = msg as unknown as { agentName?: string; message?: string; projectId?: string };
  const name = m.agentName || 'Agent';
  const body = m.message || 'sent a nudge';
  showNotification({
    id: `nudge-${m.projectId || 'x'}-${Date.now()}`,
    title: `${name} · nudge`,
    body: body.length > 140 ? body.substring(0, 140) + '...' : body,
  });
}

function notifyAgentTaskCreated(msg: WSMessage): void {
  const m = msg as unknown as {
    projectId?: string;
    task?: { id?: string; text?: string; assignedAgentId?: string | null };
  };
  const task = m.task;
  if (!task) return;
  const text = task.text || 'New task';
  showNotification({
    id: `task-${task.id || Date.now()}`,
    title: 'New agent task',
    body: text.length > 140 ? text.substring(0, 140) + '...' : text,
  });
}

function notifyGatewayStatus(connected: boolean): void {
  if (connected) {
    showNotification({
      id: `gateway-online-${Date.now()}`,
      title: 'OpenClaw online',
      body: 'Gateway connection restored',
    });
  } else {
    showNotification({
      id: `gateway-offline-${Date.now()}`,
      title: 'OpenClaw offline',
      body: 'Gateway connection lost',
    });
  }
}

// ============ App Menu ============

function createAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Open at Login',
          type: 'checkbox' as const,
          checked: app.getLoginItemSettings().openAtLogin,
          click: (menuItem: MenuItem) => {
            app.setLoginItemSettings({ openAtLogin: menuItem.checked });
          },
        },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Refresh',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.reload();
            }
          },
        },
        {
          label: 'Hard Reload (Clear Cache)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: async () => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
              await session.defaultSession.clearCache();
              mainWindow.webContents.reload();
            }
          },
        },
        { type: 'separator' },
        {
          // Native accelerator for "reopen most recently closed tab" (Warp /
          // VS Code parity). Claiming ⇧⌘T at the menu level guarantees the
          // chord fires even when focus is inside a native WebContentsView/
          // terminal pane, where the renderer's window keydown wouldn't run.
          // The renderer (App.tsx) handles the resulting `reopen-closed-tab`
          // IPC via the shared handleReopenClosedTab path.
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send('reopen-closed-tab');
            }
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: alwaysOnTop,
          accelerator: 'CmdOrCtrl+Alt+T',
          click: () => toggleAlwaysOnTop(),
        },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => { void checkForUpdatesManual(); },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ============ Tray ============

function createTray(): void {
  loadTrayIcons();
  console.log('[Topics Electron] Creating tray, icon empty?', trayIcons.normal!.isEmpty(), 'size:', trayIcons.normal!.getSize());
  tray = new Tray(trayIcons.normal!);
  console.log('[Topics Electron] Tray created');

  rebuildTrayMenu();

  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============ IPC Handlers ============

// --- Browser IPC handlers ---
// REMOVED in plan 30-01 (Phase 30 BROWSER-CHAT-01).
// 19 orphan handlers (createTab/closeTab/listTabs/activateTab/show/hide/toggle/
// isVisible/setWidth/navigate/back/forward/reload/getUrl/getTitle/executeJs/
// canGoBack/canGoForward/screenshot) had ZERO callers in client/src/ —
// Electron's BrowserView side panel was never wired into the React UI.
// The underlying browserTabs Map + createBrowserTab/closeBrowserTab + the
// CDP info server at startCDPInfoServer() are KEPT — they back OpenClaw's
// /json/list endpoint used by external tools to enumerate targets. Browser
// control inside Topics now flows through Playwright (server/browser-service.ts)
// and will be exposed via WebSocket in plan 30-02.

// --- Phase 30.1 BROWSER-CHAT-06 — Native browser IPC handlers ---
// Re-add 8 clean handlers backing WebContentsView per topic. Pulisce il
// gap del manual smoke ("ma è un browser finto in streaming?") in Electron.
// In web mode (no Electron), questi non vengono mai chiamati — il client
// detect runtime via window.electronAPI?.browserNative?.isAvailable e cade
// back al path Phase 30.

ipcMain.handle('browser-native:create', async (
  _evt,
  opts: { topicId: string; partitionId: string; initialUrl?: string }
): Promise<{ viewId: string; cdpTargetId: string }> => {
  if (!opts || typeof opts.topicId !== 'string' || !opts.topicId) {
    throw new Error('browser-native:create — topicId required');
  }
  if (typeof opts.partitionId !== 'string' || !opts.partitionId.startsWith('persist:')) {
    throw new Error('browser-native:create — partitionId must start with "persist:"');
  }
  // Phase 30.1 polish — REUSE existing view for this topicId. DnD of the
  // browser tab unmounts and remounts the React component within
  // milliseconds; without reuse, every drag would destroy + recreate the
  // WebContentsView (lose CDP target, lose loaded page, flash white).
  // The view's bound IPC channels are keyed by viewId, so the renderer
  // re-binding (subscribing to onUrlChange etc.) Just Works™.
  for (const [existingViewId, existingEntry] of nativeBrowsers) {
    if (existingEntry.topicId === opts.topicId) {
      // Cancel any pending hide-then-destroy timer (set in destroy IPC handler).
      const pending = pendingDestroys.get(existingViewId);
      if (pending) {
        clearTimeout(pending);
        pendingDestroys.delete(existingViewId);
      }
      const cdpTargetId = await resolveCdpTargetIdForView(existingEntry.view).catch(() => '');
      console.log(`[BrowserNativeManager] Reusing existing view ${existingViewId} for topic ${opts.topicId}`);
      return { viewId: existingViewId, cdpTargetId };
    }
  }
  const viewId = generateNativeViewId();
  const initialUrl = opts.initialUrl || 'about:blank';
  const entry = createNativeBrowser(opts.topicId, opts.partitionId, initialUrl);
  nativeBrowsers.set(viewId, entry);

  const wc = entry.view.webContents;

  // Wire per-view IPC senders (renderer subscribes via channels keyed by viewId).
  const sendUrl = () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(`browser-native:url-change:${viewId}`, wc.getURL());
    }
  };
  const sendTitle = (_e: unknown, title: string) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(`browser-native:title-change:${viewId}`, title);
    }
  };
  const sendLoadingStart = () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(`browser-native:loading-change:${viewId}`, true);
    }
  };
  const sendLoadingEnd = () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(`browser-native:loading-change:${viewId}`, false);
    }
  };

  // Phase 30.1 polish — favicon updates pushed to renderer for the toolbar
  // icon. Electron emits page-favicon-updated with an array of candidates
  // (favicon.ico, apple-touch-icon, etc.); take the first.
  const sendFavicon = (_e: unknown, favicons: string[]) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(`browser-native:favicon-change:${viewId}`, favicons[0] ?? '');
    }
  };

  // Phase 30.1 polish — find-in-page result events forwarded to renderer
  // so the find bar can show "M of N matches" + active match highlight.
  const sendFindResult = (_e: unknown, result: Electron.Result) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(`browser-native:find-result:${viewId}`, {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
    }
  };

  // Phase 30.1 polish — right-click context menu for the WebContentsView.
  // Provides Chrome-style entries: Back / Forward / Reload / Copy / Paste /
  // Cut / Select All / Inspect Element / Open Link / Copy Image, etc.
  // Uses MenuItem roles where possible (proper localization + Mac shortcuts).
  const onContextMenu = (_e: unknown, params: Electron.ContextMenuParams) => {
    const items: MenuItemConstructorOptions[] = [];

    // Link-specific
    if (params.linkURL) {
      items.push({
        label: 'Open Link in New Window',
        click: () => { shell.openExternal(params.linkURL).catch(() => undefined); },
      });
      items.push({ label: 'Copy Link Address', click: () => { require('electron').clipboard.writeText(params.linkURL); } });
      items.push({ type: 'separator' });
    }

    // Image-specific
    if (params.hasImageContents && params.srcURL) {
      items.push({ label: 'Copy Image Address', click: () => { require('electron').clipboard.writeText(params.srcURL); } });
      items.push({
        label: 'Save Image As…',
        click: () => { wc.downloadURL(params.srcURL); },
      });
      items.push({ type: 'separator' });
    }

    // Edit (text input / contenteditable)
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut });
      items.push({ role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ role: 'paste', enabled: params.editFlags.canPaste });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
    } else if (params.selectionText.length > 0) {
      items.push({ role: 'copy' });
    }

    if (items.length > 0) items.push({ type: 'separator' });

    // Navigation
    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    items.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    items.push({ label: 'Reload', click: () => wc.reload() });
    items.push({ type: 'separator' });

    // DevTools — opens docked on right inside Topics window.
    items.push({
      label: wc.isDevToolsOpened() ? 'Close DevTools' : 'Inspect Element',
      click: () => {
        if (wc.isDevToolsOpened()) {
          wc.closeDevTools();
        } else {
          wc.openDevTools({ mode: 'right' });
          wc.inspectElement(params.x, params.y);
        }
      },
    });

    if (mainWindow) {
      Menu.buildFromTemplate(items).popup({ window: mainWindow });
    }
  };

  wc.on('did-navigate', sendUrl);
  wc.on('did-navigate-in-page', sendUrl);
  wc.on('page-title-updated', sendTitle);
  wc.on('did-start-loading', sendLoadingStart);
  wc.on('did-stop-loading', sendLoadingEnd);
  wc.on('page-favicon-updated', sendFavicon);
  wc.on('context-menu', onContextMenu);
  wc.on('found-in-page', sendFindResult);

  entry.cleanup = () => {
    wc.removeListener('did-navigate', sendUrl);
    wc.removeListener('did-navigate-in-page', sendUrl);
    wc.removeListener('page-title-updated', sendTitle);
    wc.removeListener('did-start-loading', sendLoadingStart);
    wc.removeListener('did-stop-loading', sendLoadingEnd);
    wc.removeListener('page-favicon-updated', sendFavicon);
    wc.removeListener('context-menu', onContextMenu);
    wc.removeListener('found-in-page', sendFindResult);
  };

  // Wait for first paint before resolving CDP targetId — otherwise
  // the /json/list response may not yet contain the view (race).
  await new Promise<void>((resolve) => {
    if (!wc.isLoading()) return resolve();
    wc.once('did-stop-loading', () => resolve());
  });

  let cdpTargetId: string;
  try {
    cdpTargetId = await resolveCdpTargetIdForView(entry.view);
  } catch (err) {
    // Don't fail the create — fallback to empty cdpTargetId; agent
    // dispatcher will retry via getCdpTargetId IPC. Log for diagnosis.
    console.warn(`[browser-native:create] resolveCdpTargetId failed:`, (err as Error).message);
    cdpTargetId = '';
  }

  return { viewId, cdpTargetId };
});

ipcMain.handle('browser-native:destroy', async (_evt, viewId: string): Promise<void> => {
  // Phase 30.1 polish — defer destroy by DESTROY_GRACE_MS. If a create()
  // for the same topicId arrives within the grace period (DnD remount),
  // the timer is cancelled and the existing view is reused. Otherwise
  // the actual destroy fires after grace period elapses.
  const entry = nativeBrowsers.get(viewId);
  if (!entry) return;
  // Hide immediately so user doesn't see the orphan during grace period.
  try { entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch { /* ignore */ }
  // Cancel any prior pending destroy for this viewId (idempotent).
  const prior = pendingDestroys.get(viewId);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingDestroys.delete(viewId);
    actuallyDestroyNativeBrowser(viewId);
  }, DESTROY_GRACE_MS);
  pendingDestroys.set(viewId, timer);
});

// Internal — bypasses grace period (used by orphan sweep + reuse cancel).
function actuallyDestroyNativeBrowser(viewId: string): void {
  const pending = pendingDestroys.get(viewId);
  if (pending) {
    clearTimeout(pending);
    pendingDestroys.delete(viewId);
  }
  destroyNativeBrowser(viewId);
}

ipcMain.handle('browser-native:destroy-immediate', async (_evt, viewId: string): Promise<void> => {
  destroyNativeBrowser(viewId);
});

ipcMain.handle('browser-native:navigate', async (
  _evt, viewId: string, url: string
): Promise<{ url: string; title: string }> => {
  const entry = nativeBrowsers.get(viewId);
  // No-op (do NOT throw) for a missing view — same race as set-bounds below:
  // the renderer (useNativeBrowser.ts) fires navigate/go-back/go-forward/reload
  // without a .catch(), so a stale viewId after a destroy would surface as an
  // unhandled promise rejection (and, like set-bounds, a thrown-IPC flood). The
  // op is a no-op anyway once the view is gone, so return a benign shape.
  if (!entry) return { url: '', title: '' };
  if (typeof url !== 'string' || !url) throw new Error('browser-native:navigate — url required');
  await entry.view.webContents.loadURL(url);
  return {
    url: entry.view.webContents.getURL(),
    title: entry.view.webContents.getTitle(),
  };
});

ipcMain.handle('browser-native:go-back', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) return;  // no-op on a stale viewId — see browser-native:navigate
  const nav = (entry.view.webContents as unknown as { navigationHistory?: { goBack(): void } }).navigationHistory;
  if (nav?.goBack) nav.goBack();
  else (entry.view.webContents as unknown as { goBack(): void }).goBack?.();
});

ipcMain.handle('browser-native:go-forward', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) return;  // no-op on a stale viewId — see browser-native:navigate
  const nav = (entry.view.webContents as unknown as { navigationHistory?: { goForward(): void } }).navigationHistory;
  if (nav?.goForward) nav.goForward();
  else (entry.view.webContents as unknown as { goForward(): void }).goForward?.();
});

ipcMain.handle('browser-native:reload', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) return;  // no-op on a stale viewId — see browser-native:navigate
  entry.view.webContents.reload();
});

ipcMain.handle('browser-native:set-bounds', async (
  _evt, viewId: string, bounds: { x: number; y: number; width: number; height: number }
): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  // No-op (do NOT throw) for a missing view. set-bounds fires repeatedly from
  // the renderer's ResizeObserver/poll, so a stale viewId after a destroy used
  // to flood main with thrown IPC errors — observed as 2.3MB of logs + a frozen
  // app while the renderer↔main pane state was momentarily desynced. A gone
  // view just means the pane closed; there's nothing to position.
  if (!entry) return;
  // Round to integers — Electron's setBounds expects integer pixels.
  const safe = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  entry.view.setBounds(safe);
  entry.bounds = safe;
});

ipcMain.handle('browser-native:get-cdp-target-id', async (_evt, viewId: string): Promise<string> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:get-cdp-target-id — view ${viewId} not found`);
  return await resolveCdpTargetIdForView(entry.view);
});

// Phase 30.1 polish — Overlay window IPC: renderer requests a menu, main
// opens a transparent BrowserWindow above the parent (above WebContentsView)
// and resolves with the selected item id (or null if cancelled).
ipcMain.handle('overlay:show-menu', async (
  evt,
  opts: {
    anchor: { x: number; y: number; width: number; height: number };
    items: Array<{ id: string; label: string; iconName?: string; iconColor?: string; divider?: boolean }>;
    side?: 'bottom' | 'top' | 'right' | 'left';
    theme?: 'light' | 'dark';
    estimatedWidth?: number;
    estimatedItemHeight?: number;
  }
): Promise<string | null> => {
  const senderWin = BrowserWindow.fromWebContents(evt.sender);
  if (!senderWin) throw new Error('overlay:show-menu — no parent window');
  return await showOverlayMenu(senderWin, opts);
});

// Phase 30.1 polish — Cmd+Shift+E select-element in Electron native mode.
// Resolves the DOM element at a given (x, y) viewport coordinate using
// the WebContentsView's webContents.executeJavaScript (CDP would also work
// but executeJavaScript is simpler + same access). Returns the same shape
// as the existing /api/browsers/:id/inspect REST endpoint used by web mode.
ipcMain.handle('browser-native:inspect-at-point', async (
  _evt,
  viewId: string,
  x: number,
  y: number,
): Promise<null | {
  domPath: string;
  cssPath: string;
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
  attributes?: Record<string, string>;
}> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:inspect-at-point — view ${viewId} not found`);
  const wc = entry.view.webContents;
  // The injected script runs in the page context, so all DOM APIs are
  // available natively. Returns null if no element at the point.
  const script = `(() => {
    function getDomPath(el) {
      const path = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.body) {
        let part = cur.nodeName.toLowerCase();
        if (cur.id) { part += '#' + cur.id; path.unshift(part); break; }
        const parent = cur.parentNode;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(c => c.nodeName === cur.nodeName);
          if (sameTag.length > 1) part += '[' + (sameTag.indexOf(cur) + 1) + ']';
        }
        path.unshift(part);
        cur = cur.parentNode;
      }
      return '/html/body/' + path.join('/');
    }
    function getCssPath(el) {
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.body) {
        let s = cur.nodeName.toLowerCase();
        if (cur.id) { s += '#' + cur.id; parts.unshift(s); break; }
        const cls = (cur.className || '').toString().trim().split(/\\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += '.' + cls.join('.');
        parts.unshift(s);
        cur = cur.parentNode;
      }
      return parts.join(' > ');
    }
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!el || !(el instanceof Element)) return null;
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const text = el.textContent ? el.textContent.trim().slice(0, 80) : '';
    return {
      domPath: getDomPath(el),
      cssPath: getCssPath(el),
      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      text: text || undefined,
      attributes: Object.keys(attrs).length ? attrs : undefined,
    };
  })()`;
  try {
    return await wc.executeJavaScript(script, true);
  } catch (err) {
    console.warn(`[browser-native:inspect-at-point] executeJavaScript failed:`, (err as Error).message);
    return null;
  }
});

// Phase 30.1 polish — show downloaded file in OS file manager (Cmd+R from
// the download notification).
ipcMain.handle('browser-native:show-download-in-folder', async (_evt, savedPath: string): Promise<void> => {
  if (!savedPath) return;
  shell.showItemInFolder(savedPath);
});

// Phase 30.1 polish — Find in page (Chrome's Cmd+F).
// findInPage starts/continues a search; returns immediately, results delivered
// via 'found-in-page' event which we forward to the renderer via IPC.
ipcMain.handle('browser-native:find-in-page', async (
  _evt,
  viewId: string,
  text: string,
  options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }
): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:find-in-page — view ${viewId} not found`);
  if (!text) {
    entry.view.webContents.stopFindInPage('clearSelection');
    return;
  }
  entry.view.webContents.findInPage(text, {
    forward: options?.forward ?? true,
    matchCase: options?.matchCase ?? false,
    findNext: options?.findNext ?? false,
  });
});

ipcMain.handle('browser-native:stop-find', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) return; // idempotent
  entry.view.webContents.stopFindInPage('clearSelection');
});

// Phase 30.1 polish — Zoom controls (Cmd+ / Cmd- / Cmd0).
// Electron stores zoom as 'zoom level' (integer-ish, 0 = 100%). Each step
// is roughly a 20% delta. Clamp to [-3, 5] to match Chrome's Cmd+/- range.
ipcMain.handle('browser-native:set-zoom', async (
  _evt,
  viewId: string,
  delta: number | 'reset'
): Promise<number> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:set-zoom — view ${viewId} not found`);
  const wc = entry.view.webContents;
  if (delta === 'reset') {
    wc.setZoomLevel(0);
    return 0;
  }
  const next = Math.max(-3, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(next);
  return next;
});

// Phase 30.1 BROWSER-CHAT-06 polish — DevTools toggle for native WebContentsView.
// Default mode: 'right' — DevTools docks inside the Topics window next to the
// browser pane. User can switch to 'undocked' (separate window) from the
// DevTools UI itself (icon in top-right of the DevTools panel).
// Idempotent: closes if open.
ipcMain.handle('browser-native:toggle-devtools', async (
  _evt,
  viewId: string,
  mode?: 'right' | 'bottom' | 'left' | 'undocked' | 'detach'
): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:toggle-devtools — view ${viewId} not found`);
  const wc = entry.view.webContents;
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools();
  } else {
    wc.openDevTools({ mode: mode ?? 'right' });
  }
});

// --- Window Control ---
ipcMain.handle('window:close', () => {
  mainWindow?.hide();
});

ipcMain.handle('app:quit', () => {
  (app as unknown as { isQuitting: boolean }).isQuitting = true;
  app.quit();
});

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('app:toggle-always-on-top', () => {
  toggleAlwaysOnTop();
  return { success: true, alwaysOnTop };
});

ipcMain.handle('app:get-always-on-top', () => {
  return { alwaysOnTop };
});

// --- Shell ---
ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (url.startsWith('https://') || url.startsWith('http://')) {
    await shell.openExternal(url);
  }
});

// --- Dialog ---
ipcMain.handle('dialog:selectDirectory', async () => {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Project Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ─── Phase B · DAEMON-03 — LaunchAgent management (macOS) ──────────────────
const DAEMON_LABEL = 'com.armonia.topics-daemon';
const TOPICS_HOME_DIR = path.join(process.env.HOME || '', '.topics');
const PLIST_PATH = path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);

function buildDaemonPlist(serverDir: string, bunPath: string): string {
  const logsPath = path.join(TOPICS_HOME_DIR, 'logs', 'daemon.log');
  // Hand-rolled XML keeps the dep tree small and the output diff-friendly, but
  // every interpolated path MUST be XML-escaped: HOME and the install dir are
  // user-controlled and macOS folder names may legally contain & < >, which
  // would otherwise emit malformed XML that `launchctl bootstrap` rejects.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(DAEMON_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(bunPath)}</string>
    <string>run</string>
    <string>${esc(path.join(serverDir, 'server.ts'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(serverDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(logsPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logsPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>HOME</key><string>${esc(process.env.HOME || '')}</string>
    <key>PATH</key><string>${esc(path.dirname(bunPath))}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

async function findBunPath(): Promise<string> {
  const { execFile: execFileCb } = await import('child_process');
  return await new Promise<string>((resolve, reject) => {
    execFileCb('/usr/bin/which', ['bun'], (err, stdout) => {
      if (err) return reject(err);
      const bun = stdout.trim();
      if (!bun) return reject(new Error('bun not found on PATH'));
      resolve(bun);
    });
  });
}

async function launchctl(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  // execFile with explicit argv prevents shell injection — the user
  // never controls these args.
  const { execFile: execFileCb } = await import('child_process');
  return await new Promise((resolve) => {
    execFileCb('/bin/launchctl', args, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
        code: err && (err as any).code != null ? (err as any).code : err ? 1 : 0,
      });
    });
  });
}

ipcMain.handle('daemon:install-launchagent', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'LaunchAgent is macOS-only' };
  }
  try {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.mkdirSync(path.join(TOPICS_HOME_DIR, 'logs'), { recursive: true });
    const bunPath = await findBunPath();
    // The Electron app is launched from inside the Topics repo; resolve
    // the server.ts location off the resourcesPath in production builds
    // and __dirname during dev.
    const serverDir =
      app.isPackaged
        ? path.resolve(process.resourcesPath, 'server')
        : path.resolve(__dirname, '..', '..');
    fs.writeFileSync(PLIST_PATH, buildDaemonPlist(serverDir, bunPath), { mode: 0o644 });
    const uid = process.getuid?.() ?? 0;
    const result = await launchctl(['bootstrap', `gui/${uid}`, PLIST_PATH]);
    if (result.code !== 0 && !result.stderr.includes('already')) {
      return { ok: false, error: `launchctl bootstrap failed: ${result.stderr.trim()}` };
    }
    return { ok: true, plistPath: PLIST_PATH };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('daemon:uninstall-launchagent', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'LaunchAgent is macOS-only' };
  }
  try {
    const uid = process.getuid?.() ?? 0;
    // bootout is forgiving: if the agent isn't loaded it returns non-zero
    // but it's harmless. We still try to delete the plist so the user
    // ends up in a clean state either way.
    await launchctl(['bootout', `gui/${uid}/${DAEMON_LABEL}`]);
    if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('daemon:status', async () => {
  // Read the daemon-state.json + ping /__daemon/healthz with the token.
  const launchAgentInstalled =
    process.platform === 'darwin' && fs.existsSync(PLIST_PATH);
  const statePath = path.join(TOPICS_HOME_DIR, 'daemon-state.json');
  if (!fs.existsSync(statePath)) {
    return { running: false, launchAgentInstalled };
  }
  let state: { pid: number; port: number; token: string; startedAt: string } | null = null;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return { running: false, launchAgentInstalled };
  }
  if (!state) return { running: false, launchAgentInstalled };
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/__daemon/healthz`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json()) as { pid: number; uptime_ms: number };
      return {
        running: true,
        pid: body.pid,
        uptimeMs: body.uptime_ms,
        port: state.port,
        launchAgentInstalled,
      };
    }
  } catch {
    /* daemon not actually running — state file is stale */
  }
  return { running: false, launchAgentInstalled, pidHint: state.pid };
});

// --- Detached Windows ---
ipcMain.handle('window:detach', async (_event, topicId: string) => {
  const url = `${SERVER_URL}?topic=${topicId}`;
  createDetachedWindow(topicId, url);
  return { success: true };
});

ipcMain.handle('window:listDetached', async () => {
  const windows: { topicId: string; focused: boolean }[] = [];
  for (const [topicId, win] of detachedWindows) {
    if (!win.isDestroyed()) {
      windows.push({ topicId, focused: win.isFocused() });
    }
  }
  return { windows };
});

ipcMain.handle('window:focusDetached', async (_event, topicId: string) => {
  const win = detachedWindows.get(topicId);
  if (win && !win.isDestroyed()) {
    win.focus();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('window:closeDetached', async (_event, topicId: string) => {
  const win = detachedWindows.get(topicId);
  if (win && !win.isDestroyed()) {
    win.close();
    return { success: true };
  }
  return { success: false };
});

// --- Topic Focus Tracking ---
ipcMain.on('topic:focused', (_event, topicId: string) => {
  trayState.focusedTopicId = topicId || null;
});

ipcMain.handle('window:focusMain', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return { success: true };
  }
  return { success: false };
});

// ============ Traffic Light Visibility ============

ipcMain.handle('window:showTrafficLights', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.setWindowButtonVisibility(true);
  }
});

ipcMain.handle('window:hideTrafficLights', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // Never hide the buttons while the main window is full-screen — they're
  // the only exit affordance there.
  if (win && !win.isDestroyed() && !(win === mainWindow && mainWindowFullScreen)) {
    win.setWindowButtonVisibility(false);
  }
});

// ============ CDP HTTP Server for OpenClaw ============

function startCDPInfoServer(): void {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/tabs') {
      const tabs: { id: string; url: string; title: string; active: boolean }[] = [];
      for (const [id, tab] of browserTabs) {
        if (!tab.view.webContents.isDestroyed()) {
          tabs.push({
            id,
            url: tab.url || tab.view.webContents.getURL(),
            title: tab.title || tab.view.webContents.getTitle() || 'Tab',
            active: id === activeTabId,
          });
        }
      }
      res.end(JSON.stringify({ tabs, activeTabId, browserPanelVisible }));
      return;
    }

    if (req.url === '/json/list' || req.url === '/json') {
      const targets: Record<string, unknown>[] = [];

      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        targets.push({
          id: 'topics-main',
          type: 'page',
          title: mainWindow.webContents.getTitle() || 'Topics',
          url: mainWindow.webContents.getURL(),
          webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/topics-main`,
          devtoolsFrontendUrl: '',
        });
      }

      for (const [id, tab] of browserTabs) {
        if (!tab.view.webContents.isDestroyed()) {
          targets.push({
            id,
            type: 'page',
            title: tab.title || tab.view.webContents.getTitle() || 'Tab',
            url: tab.url || tab.view.webContents.getURL(),
            webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/${id}`,
            devtoolsFrontendUrl: '',
          });
        }
      }

      res.end(JSON.stringify(targets));
      return;
    }

    if (req.url === '/json/version') {
      res.end(JSON.stringify({
        Browser: 'Topics-Electron/1.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'Topics Electron App',
        'V8-Version': process.versions.v8,
        'WebKit-Version': '',
        webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}`,
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(CDP_INFO_PORT, '127.0.0.1', () => {
    console.log(`[Topics Electron] CDP info server listening on http://127.0.0.1:${CDP_INFO_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const altPort = CDP_INFO_PORT + 1;
      console.log(`[Topics Electron] Port ${CDP_INFO_PORT} in use, trying ${altPort}`);
      server.listen(altPort, '127.0.0.1', () => {
        console.log(`[Topics Electron] CDP info server listening on http://127.0.0.1:${altPort}`);
      });
    } else {
      console.error('[Topics Electron] CDP server error:', err);
    }
  });
}

// ============ Production Asset Watcher ============

let watchedIndexHtml: string | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function startAssetWatcher(): void {
  // DEFAULT ON, OPT-OUT via env var (revised 2026-05-11, fourth pass).
  //
  // Earlier passes had two failure modes:
  //   · `app.isPackaged` gate (v1) — false in our prod workflow that
  //     launches Electron via the bare binary, so the watcher fired
  //     during Claude-session edits and the user saw apparent random
  //     reloads.
  //   · default-OFF (v3) — killed the legitimate dev workflow where a
  //     developer expects the window to refresh after they save a
  //     file. Throwing the baby out with the bathwater.
  //
  // What the user actually wants:
  //   · When *they* edit code → reload                  (this is fine)
  //   · When the app is idle  → NO reload               (no surprises)
  //
  // The on-disk trigger (`public/index.html` mtime change) is the same
  // in both cases, so the watcher can't tell them apart from the
  // filesystem alone. Instead we keep the watcher ON by default — the
  // *cause* of an idle reload was always an external rebuild (a Claude
  // session editing many files via the `start-prod.sh` fswatch loop,
  // a `git pull`, etc.), and those still propagate. When the user wants
  // a no-reload window (e.g. a long pair-programming session with
  // Claude that's about to touch dozens of files), they set
  // `TOPICS_AUTO_RELOAD=0` and the watcher stays asleep.
  //
  //   · TOPICS_AUTO_RELOAD unset    → watcher ON  (default, dev-friendly)
  //   · TOPICS_AUTO_RELOAD=1        → watcher ON  (explicit force)
  //   · TOPICS_AUTO_RELOAD=0        → watcher OFF (pause mode)
  if (process.env.TOPICS_AUTO_RELOAD === '0') {
    console.log('[Topics Electron] Asset watcher disabled by TOPICS_AUTO_RELOAD=0');
    return;
  }

  // __dirname is electron-app/dist/, /public lives at workspace root
  // (topics-app/public). Earlier path joined to electron-app/public, which
  // never exists, so the watcher silently no-op'd — auto-reload was dead.
  const candidates = [
    path.join(__dirname, '..', '..', 'public'),
    path.join(__dirname, '..', 'public'),
  ];
  const publicDir = candidates.find(p => fs.existsSync(p));
  if (!publicDir) {
    console.log('[Topics Electron] /public/ directory not found, skipping asset watcher');
    return;
  }

  try {
    // Only react to index.html — Vite writes it LAST after all hashed chunks
    // are in place. Watching all assets would fire mid-build and reload onto
    // an HTML that still references chunks that don't exist yet, which is
    // what was wiping tab/panel state. Debounce stays as a safety net.
    //
    // Why fs.watchFile (polling) instead of fs.watch:
    //   fs.watch with { recursive: true } on macOS is backed by FSEvents and
    //   drops events when files are written quickly or via atomic rename
    //   (which Vite does). Symptom: the user edits a CSS file, vite rebuilds
    //   public/index.html, but Electron never reloads — they think the prod
    //   app is stuck and have to kickstart the LaunchAgent. fs.watchFile
    //   polls mtime at a fixed interval, so it never misses a change.
    //   500 ms is fine: a vite rebuild already takes ~3 s, the polling cost
    //   is negligible (a single stat() per tick on one file).
    watchedIndexHtml = path.join(publicDir, 'index.html');
    fs.watchFile(watchedIndexHtml, { interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        console.log(`[Topics Electron] index.html updated, reloading... (dev mode)`);
        reloadAllAppWindows();
      }, 500);
    });

    console.log(`[Topics Electron] Asset watcher started on ${watchedIndexHtml} (polling 500ms)`);
  } catch (err: unknown) {
    console.error('[Topics Electron] Failed to start asset watcher:', (err as Error).message);
  }
}

function reloadAllAppWindows(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.reload();
  }

  for (const [, win] of detachedWindows) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.reload();
    }
  }
}

function stopAssetWatcher(): void {
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = null;
  }
  if (watchedIndexHtml) {
    fs.unwatchFile(watchedIndexHtml);
    watchedIndexHtml = null;
    console.log('[Topics Electron] Asset watcher stopped');
  }
}

// ============ Crash Recovery ============

let crashCount = 0;
let crashWindowStart = Date.now();

function handleCrash(error: unknown, source: string): void {
  console.error(`[Topics Electron] ${source}:`, error);

  const now = Date.now();
  if (now - crashWindowStart > 60000) {
    crashCount = 0;
    crashWindowStart = now;
  }
  crashCount++;

  if (crashCount <= 3) {
    console.log(`[Topics Electron] Restarting after crash (${crashCount}/3 in window)...`);
    app.relaunch();
    app.exit(1);
  } else {
    console.error('[Topics Electron] Too many crashes in 60s, not restarting');
  }
}

process.on('uncaughtException', (error) => {
  handleCrash(error, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  handleCrash(reason, 'Unhandled rejection');
});

// ============ App Lifecycle ============

// Prevent multiple instances — second instance exits immediately
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Topics Electron] Another instance is running, quitting.');
  app.quit();
}

app.on('second-instance', () => {
  // Don't steal focus — launchd KeepAlive can trigger this repeatedly
  console.log('[Topics Electron] Second instance detected, ignoring.');
});

app.whenReady().then(async () => {
  // When running unpacked (LaunchAgent dev/prod scripts both run
  // node_modules/.bin/electron, never a built .app bundle), macOS uses the
  // generic Electron icon. Force our own. When packaged via electron-builder
  // the bundle's CFBundleIconFile takes over, so we only override here.
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
    if (isDev) app.setName('Topics DEV');
  }

  const prefs = loadPreferences();
  alwaysOnTop = prefs.alwaysOnTop || false;

  createAppMenu();
  // Phase 30.1 polish — overlay manager IPC handlers register here.
  initOverlayManager();
  // Window + tray FIRST, before any server work, so the app ALWAYS visibly
  // opens (loading page) and is ALWAYS quittable (tray Quit) within a second —
  // even if the bundled server is slow or never starts. createWindow polls the
  // server and swaps in the real app when it's ready. Independent try/catch so
  // a failure in one never prevents the other — the tray Quit must exist even
  // if window creation throws.
  try { createWindow(); } catch (e) { console.error('[Topics Electron] createWindow failed:', e); }
  try { createTray(); } catch (e) { console.error('[Topics Electron] createTray failed:', e); }
  // Packaged builds: spawn the bundled server (no-op in dev / when one is
  // already running). NOT awaited before the window — the window's own poller
  // drives the connect, so a slow/failed server can't keep the UI off-screen.
  startBundledServer().catch((err) => console.error('[Server] start failed:', err));
  startWSBridge();
  startNotificationCleanup();
  startCDPInfoServer();
  startAssetWatcher();

  if (alwaysOnTop && mainWindow) {
    mainWindow.setAlwaysOnTop(true, 'floating');
  }

  // Keyboard shortcut for Always-on-Top toggle (Cmd/Ctrl+Alt+T). Deliberately
  // NOT Shift+T: that chord is the browser's "reopen closed tab", and a global
  // shortcut would steal it system-wide for as long as this app is running.
  try {
    const registered = globalShortcut.register('CommandOrControl+Alt+T', () => {
      // Reuse the canonical toggle so the persisted-state and dual menu
      // (tray + app) rebuilds stay in sync with the menu accelerator.
      toggleAlwaysOnTop();
    });
    if (!registered) {
      console.warn('[Topics Electron] Failed to register CommandOrControl+Alt+T shortcut (likely in use by another app)');
    }
  } catch (err) {
    console.warn('[Topics Electron] globalShortcut.register threw:', err);
  }

  const loginSettings = app.getLoginItemSettings();
  if (!loginSettings.openAtLogin && !loginSettings.wasOpenedAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (e) => {
  // Only quit if explicitly requested via tray menu (which sets isQuitting=true first).
  // Cmd+Q or menu Quit hides all windows instead, keeping tray alive.
  if (!(app as unknown as { isQuitting: boolean }).isQuitting) {
    e.preventDefault();
    BrowserWindow.getAllWindows().forEach(w => { try { w.hide(); } catch (_e) { /* ignore */ } });
    console.log('[Topics Electron] Cmd+Q intercepted — hiding windows, tray stays');
  }
});

// Per-region vibrancy IPC: the renderer streams the panel rects (one batch per
// settled layout) and we upsert NSVisualEffectViews under them; it sends an
// empty array (or clears) during drag/resize so the frost doesn't lag the
// gesture. Fire-and-forget `send` (not invoke) to keep it cheap.
ipcMain.on('vibrancy:set-regions', (_evt, rects: unknown[]) => {
  if (!vibrancy.available || !mainWindow || mainWindow.isDestroyed()) return;
  try { vibrancy.setRegions(mainWindow.getNativeWindowHandle(), Array.isArray(rects) ? rects : [], 'sidebar'); }
  catch { /* no-op */ }
});
ipcMain.on('vibrancy:clear', () => {
  if (!vibrancy.available || !mainWindow || mainWindow.isDestroyed()) return;
  try { vibrancy.clear(mainWindow.getNativeWindowHandle()); } catch { /* no-op */ }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch { /* best effort */ }
  // Release native vibrancy views before teardown so no lingering refs hang quit.
  try { if (mainWindow && !mainWindow.isDestroyed()) vibrancy.clear(mainWindow.getNativeWindowHandle()); } catch { /* best effort */ }
  stopBundledServer();
  stopWSBridge();
  stopNotificationCleanup();
  stopAssetWatcher();
  // Phase 30.1 — cancel any pending grace-destroy timers so they can't fire
  // after window teardown, then destroy any native browser views still alive.
  for (const timer of pendingDestroys.values()) {
    try { clearTimeout(timer); } catch { /* best effort */ }
  }
  pendingDestroys.clear();
  for (const viewId of nativeBrowsers.keys()) {
    try { destroyNativeBrowser(viewId); } catch { /* best effort */ }
  }
});

// Allow self-signed TLS certificates for localhost
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', '');
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  // The main window loads https://127.0.0.1:3333 (deliberately 127.0.0.1, not
  // localhost, to dodge the IPv4/IPv6 happy-eyeballs WS bug), so the bypass must
  // cover the loopback hosts the app actually uses — not just 'localhost', which
  // the window never loads. Rejecting 127.0.0.1 here made the cert trust hinge
  // on an Electron cache quirk (ERR_CERT_AUTHORITY_INVALID on a fresh profile or
  // Electron upgrade).
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// Enable remote debugging for the whole app
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

// ─── Phase F · No-flash boot (3rd layer: native chrome theme sync) ─────────
// Layer 1 (theme-init script) and 2 (critical CSS) already live in
// client/index.html. The 3rd layer hooks the renderer's resolved theme
// up to nativeTheme.themeSource so the macOS title bar / vibrancy
// material match without a flash on toggle.
ipcMain.handle('theme:set-resolved', async (_evt, resolved: 'light' | 'dark') => {
  try {
    const { nativeTheme } = await import('electron');
    if (resolved === 'light' || resolved === 'dark') {
      nativeTheme.themeSource = resolved;
      return { ok: true };
    }
    return { ok: false, error: 'invalid theme' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ─── Phase F · Notifications scoped + rate-limit ───────────────────────────
// Two trigger types only: agent_completed and permission_requested.
// Window: 5 notifications in 10 seconds; suppressed entirely when the
// main window is focused (the user is already looking at it).
const NOTIF_WINDOW_MS = 10_000;
const NOTIF_LIMIT = 5;
const notifTimes: number[] = [];

function shouldSuppressNotification(): boolean {
  // Suppress when the main window is focused — caller is staring at it.
  const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
  if (focused) return true;
  // Sliding-window rate limit.
  const now = Date.now();
  while (notifTimes.length > 0 && now - notifTimes[0] > NOTIF_WINDOW_MS) {
    notifTimes.shift();
  }
  if (notifTimes.length >= NOTIF_LIMIT) return true;
  notifTimes.push(now);
  return false;
}

ipcMain.handle('notification:show-scoped', async (_evt, payload: {
  trigger: 'agent_completed' | 'permission_requested';
  title?: string;
  body: string;
  topicId?: string;
}) => {
  if (shouldSuppressNotification()) {
    return { ok: false, reason: 'suppressed' };
  }
  const { Notification: ElectronNotification } = await import('electron');
  if (!ElectronNotification.isSupported()) {
    return { ok: false, reason: 'not-supported' };
  }
  const defaults = {
    agent_completed: 'Agent completed',
    permission_requested: 'Permission requested',
  } as const;
  const title = payload.title ?? defaults[payload.trigger];
  const notif = new ElectronNotification({
    title: title.slice(0, 256),
    body: (payload.body || '').slice(0, 1024),
    silent: false,
  });
  notif.on('click', () => {
    // Bring the main window to front; renderer can listen for the
    // existing 'navigate' channel if topicId is provided.
    const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (main) {
      if (main.isMinimized()) main.restore();
      main.focus();
      if (payload.topicId) {
        main.webContents.send('navigate-to-topic', payload.topicId);
      }
    }
  });
  notif.show();
  return { ok: true };
});

// ─── Phase F · Caffeinate mode (macOS) ─────────────────────────────────────
// Three states: 'off', 'power' (only while on AC), 'always'.
// Implementation: spawn `caffeinate` subprocess; state cached in module
// scope. The renderer polls `caffeinate:get-mode` for the badge.
type CaffeinateMode = 'off' | 'power' | 'always';
let caffeinateMode: CaffeinateMode = 'off';
let caffeinateProc: { kill: () => void } | null = null;
let caffeinateLastReleaseReason: string | null = null;

async function setCaffeinate(mode: CaffeinateMode): Promise<void> {
  if (process.platform !== 'darwin') {
    caffeinateMode = 'off';
    return;
  }
  // Always kill any previous process — we're switching modes.
  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch {}
    caffeinateProc = null;
  }
  caffeinateMode = mode;
  if (mode === 'off') return;
  // Flags: -d display, -i system idle, -m disk idle, -s only on AC
  // Always: -dim. Power: -dimu (only while on AC, plug-out exits via 'died' event below).
  const args = mode === 'power' ? ['-dimu'] : ['-dim'];
  const { spawn } = await import('child_process');
  const proc = spawn('/usr/bin/caffeinate', args, { stdio: 'ignore', detached: false });
  caffeinateProc = proc;
  proc.on('exit', () => {
    if (caffeinateProc === proc) {
      caffeinateProc = null;
      // Surface a release reason if the user was in 'always' or 'power' and
      // the process exited unexpectedly. The reason copy mirrors the
      // reference desktop client we studied.
      if (caffeinateMode !== 'off') {
        caffeinateLastReleaseReason =
          mode === 'power' ? 'AC power disconnected' : 'caffeinate process exited';
        caffeinateMode = 'off';
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('caffeinate:released', {
              reason: caffeinateLastReleaseReason,
            });
          }
        }
      }
    }
  });
}

ipcMain.handle('caffeinate:set-mode', async (_evt, mode: CaffeinateMode) => {
  if (mode !== 'off' && mode !== 'power' && mode !== 'always') {
    return { ok: false, error: 'invalid mode' };
  }
  try {
    await setCaffeinate(mode);
    return { ok: true, mode: caffeinateMode };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('caffeinate:get-mode', () => ({
  mode: caffeinateMode,
  lastReleaseReason: caffeinateLastReleaseReason,
}));

// Clean up on quit — ONLY on a real quit. The other before-quit handler
// preventDefault()s Cmd+Q and hides to tray instead of quitting, so killing
// caffeinate here unconditionally defeated "always stay awake" on every Cmd+Q
// and fired a misleading caffeinate:released toast for a release the user never
// asked for.
app.on('before-quit', () => {
  if (!(app as unknown as { isQuitting: boolean }).isQuitting) return;
  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch {}
    caffeinateProc = null;
  }
});

// ─── Phase E · Auto-update (electron-updater) ──────────────────────────────
//
// FULLY OPT-IN UPDATE FLOW (since 2026-05-11). Requested behaviour:
// the app must NEVER download or install updates without explicit user
// consent.
//
// Old (removed) behaviour:
//   · `autoDownload = true`         → silently downloaded any update found
//   · `autoInstallOnAppQuit = true` → silently installed on next quit
//   · Background `tryCheck` polling every 30 s / 60 s / 5 min / 15 min /
//     30 min — surfaced "downloading…" toasts unprompted.
//
// New behaviour (this file):
//   · `autoDownload = false`         → an `update-available` event is
//     fired but NOTHING is downloaded. The toast surfaces a "Download" CTA.
//   · `autoInstallOnAppQuit = false` → never modify the install on quit.
//   · NO background polling. The renderer triggers checks via the IPC
//     `updater:check-for-updates` (currently driven by the user's "Check
//     for updates" action).
//   · Three explicit steps gated by IPC:
//       1. updater:check-for-updates → metadata only
//       2. updater:download-update   → starts the actual download
//       3. updater:quit-and-install  → installs and restarts
//   · On startup we still register the listeners and run ONE check after
//     a 30 s grace so the toast can offer the CTA — but never auto-act.
//
// Lazy-import inside handlers so dev (where the dep may not yet be installed
// or the file is being type-checked without the module) doesn't crash.
type UpdaterState =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'ready'
  | 'error';

let updaterReady = false;
let lastUpdaterStatus: { state: UpdaterState; progress?: number; error?: string } = { state: 'idle' };

function broadcastUpdaterStatus(status: typeof lastUpdaterStatus) {
  lastUpdaterStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:status', status);
    }
  }
}

// ─── Phase E.3 · Unsigned-macOS update path ─────────────────────────────────
//
// electron-updater's mac flow hands the downloaded archive to Squirrel.Mac,
// which refuses to install into an app that isn't Developer-ID signed
// ("Could not get code signature for running application"). Until Apple
// signing secrets land in CI our mac builds are ad-hoc signed at best, so on
// darwin we probe the signature once and, when there's no real Team ID, swap
// in a self-managed flow behind the SAME updater states + IPC surface:
//   check   → read latest-mac.yml straight from the GitHub release
//   download→ stream the universal zip to tmp, verify its sha512 (the
//             base64 digest electron-builder publishes), ditto-extract
//             (ditto preserves the symlinks + exec bits a .app needs)
//   install → detached shell script waits for the app to exit, swaps the
//             bundle (with rollback), strips quarantine, relaunches
// Programmatic downloads never set the quarantine xattr (we don't opt into
// LSFileQuarantineEnabled), so Gatekeeper doesn't re-assess the swapped
// bundle — the xattr strip is just belt-and-braces. The moment a build IS
// properly signed, the probe flips and electron-updater takes over again.

const GH_RELEASES = 'https://github.com/armonia/topics-app/releases';

let macCustomActive = false;
let macUpdateInfo: { version: string; fileName: string; sha512: string; size: number } | null = null;
let macUpdateAppPath: string | null = null; // extracted .app, ready to swap in

function macAppBundlePath(): string {
  // …/Topics.app/Contents/MacOS/Topics → …/Topics.app
  return path.resolve(app.getPath('exe'), '..', '..', '..');
}

/** True only for a real Developer ID signature — ad-hoc ("Signature=adhoc",
 *  what electron-builder applies on arm64 when no identity is configured)
 *  still fails Squirrel.Mac, so it counts as unsigned here. */
function isMacAppProperlySigned(): Promise<boolean> {
  return new Promise((resolve) => {
    void import('child_process').then(({ execFile }) => {
      execFile('/usr/bin/codesign', ['-dvv', macAppBundlePath()], (err, _stdout, stderr) => {
        if (err) return resolve(false); // not signed at all
        const out = String(stderr || ''); // codesign prints details on stderr
        if (/Signature=adhoc/.test(out)) return resolve(false);
        const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
        resolve(!!team && team !== 'not set');
      });
    }).catch(() => resolve(false));
  });
}

function fetchTextFollowingRedirects(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return fetchTextFollowingRedirects(loc, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
    // Inactivity watchdog: a half-open socket (sleep/wake, dropped NAT entry)
    // emits neither 'error' nor 'end' — without this the promise never
    // settles and the caller's state machine wedges until app restart.
    req.setTimeout(30_000, () => req.destroy(new Error('Network timeout while checking for updates')));
  });
}

function downloadFileWithProgress(url: string, dest: string, expectedSize: number, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return downloadFileWithProgress(loc, dest, expectedSize, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length']) || expectedSize || 0;
      let got = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk: Buffer) => {
        got += chunk.length;
        if (total > 0) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            broadcastUpdaterStatus({ state: 'downloading', progress: pct });
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', (err) => { res.resume(); reject(err); });
      res.on('error', reject);
    }).on('error', reject);
    // Inactivity (not total-duration) watchdog — large archives on slow links
    // are fine as long as bytes keep flowing; a silent stall rejects so the
    // download latch is released and the user can retry.
    req.setTimeout(60_000, () => req.destroy(new Error('Network timeout while downloading the update')));
  });
}

async function sha512Base64(filePath: string): Promise<string> {
  const { createHash } = await import('crypto');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('base64')));
    stream.on('error', reject);
  });
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Guard against a check racing/clobbering an active download's state. */
let macDownloadPromise: Promise<void> | null = null;
/** Version of the .app already staged next to the bundle, ready to install. */
let macStagedVersion: string | null = null;
/** Latch: a swap script has been spawned — never spawn a second one. */
let macInstallStarted = false;

async function macCheckForUpdates(): Promise<{ updateAvailable: boolean; version?: string }> {
  // Don't clobber 'downloading'/'ready' with 'checking' broadcasts while a
  // download is in flight or an install is already staged.
  if (macDownloadPromise || macStagedVersion) {
    if (macStagedVersion && macUpdateAppPath && fs.existsSync(macUpdateAppPath)) {
      // Re-assert 'ready' so a check can recover the toast from a sticky
      // 'error' left by a failed install attempt.
      broadcastUpdaterStatus({ state: 'ready' });
    }
    return { updateAvailable: !!macUpdateInfo, version: macUpdateInfo?.version };
  }
  try {
    broadcastUpdaterStatus({ state: 'checking' });
    const yml = await fetchTextFollowingRedirects(`${GH_RELEASES}/latest/download/latest-mac.yml`);
    const version = /^version:\s*(\S+)/m.exec(yml)?.[1];
    // electron-builder lists every artifact; we want the universal zip entry.
    const fileRe = /-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/g;
    let zipEntry: { fileName: string; sha512: string; size: number } | null = null;
    for (let m = fileRe.exec(yml); m; m = fileRe.exec(yml)) {
      if (m[1].endsWith('.zip')) { zipEntry = { fileName: m[1], sha512: m[2], size: Number(m[3]) }; break; }
    }
    if (!version || !zipEntry) throw new Error('Malformed latest-mac.yml in the GitHub release');
    if (!isNewerVersion(version, app.getVersion())) {
      macUpdateInfo = null;
      broadcastUpdaterStatus({ state: 'idle' });
      return { updateAvailable: false };
    }
    macUpdateInfo = { version, ...zipEntry };
    broadcastUpdaterStatus({ state: 'update-available' });
    return { updateAvailable: true, version };
  } catch (err) {
    // Broadcast here so EVERY caller (boot check, IPC, Help menu) leaves the
    // renderer in 'error' rather than stuck on a stale 'checking' spinner.
    broadcastUpdaterStatus({ state: 'error', error: (err as Error)?.message || String(err) });
    throw err;
  }
}

function macDownloadUpdate(): Promise<void> {
  // Re-entrancy latch: a second invocation (toast double-click, Help-menu
  // check mid-download) joins the in-flight download instead of rmSync-ing
  // the tmp dir out from under it.
  if (macDownloadPromise) return macDownloadPromise;
  macDownloadPromise = macDownloadUpdateInner().finally(() => { macDownloadPromise = null; });
  return macDownloadPromise;
}

async function macDownloadUpdateInner(): Promise<void> {
  if (!macUpdateInfo) throw new Error('No update available — run a check first');
  const { version, fileName, sha512, size } = macUpdateInfo;
  const appBundle = macAppBundlePath();
  if (macStagedVersion === version && macUpdateAppPath && fs.existsSync(macUpdateAppPath)) {
    // Already downloaded + staged (user picked "Later" earlier) — go
    // straight back to the restart prompt.
    broadcastUpdaterStatus({ state: 'ready' });
    await macPromptRestartAndInstall(version);
    return;
  }
  const tmpDir = path.join(app.getPath('temp'), `topics-update-${version}`);
  const stagedPath = `${appBundle}.new-${process.pid}`;
  try {
    // Preflight the install constraints BEFORE pulling a ~300 MB archive.
    // Gatekeeper translocation = we'd be swapping a read-only randomized copy.
    if (appBundle.includes('/AppTranslocation/')) {
      throw new Error('Topics is running from a quarantined location. Move Topics.app to /Applications, launch it from there, then update.');
    }
    try {
      fs.accessSync(appBundle, fs.constants.W_OK);
      fs.accessSync(path.dirname(appBundle), fs.constants.W_OK);
    } catch {
      throw new Error(`No write permission for ${appBundle} — move Topics.app somewhere you own (e.g. /Applications) and retry.`);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, fileName);
    broadcastUpdaterStatus({ state: 'downloading', progress: 0 });
    await downloadFileWithProgress(`${GH_RELEASES}/download/v${version}/${fileName}`, zipPath, size);
    const digest = await sha512Base64(zipPath);
    if (digest !== sha512) throw new Error('sha512 mismatch — corrupted download');
    const extractDir = path.join(tmpDir, 'extracted');
    const { execFile } = await import('child_process');
    const execFileP = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    });
    await execFileP('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    const appName = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'));
    if (!appName) throw new Error('No .app bundle inside the update archive');
    // The zip is sha512-verified and extracted — drop it now so the peak
    // disk footprint during staging is 2 copies of the app, not 3.
    fs.rmSync(zipPath, { force: true });
    // Stage the verified bundle as a SIBLING of the installed app while we
    // can still surface errors: tmp may live on a different volume, where
    // mv degrades to a non-atomic copy (a mid-copy failure during the swap
    // would leave a half-written Topics.app). Sibling → same device → both
    // swap mvs are atomic renames. ditto preserves symlinks + exec bits.
    fs.rmSync(stagedPath, { recursive: true, force: true });
    await execFileP('/usr/bin/ditto', [path.join(extractDir, appName), stagedPath]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    macUpdateAppPath = stagedPath;
    macStagedVersion = version;
    broadcastUpdaterStatus({ state: 'ready' });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(stagedPath, { recursive: true, force: true });
    macUpdateAppPath = null;
    macStagedVersion = null;
    broadcastUpdaterStatus({ state: 'error', error: (err as Error)?.message || String(err) });
    throw err;
  }
  await macPromptRestartAndInstall(version);
}

/** Mirror of the electron-updater 'update-downloaded' native prompt. */
async function macPromptRestartAndInstall(version: string): Promise<void> {
  const { dialog } = await import('electron');
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Restart & Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'A new version of Topics is ready',
    detail: `Version ${version} has been downloaded. Restart to install it now?`,
  });
  if (response === 0) {
    const res = await macQuitAndInstall();
    if (!res.ok && res.reason) {
      await dialog.showMessageBox({
        type: 'warning',
        message: 'Could not install the update',
        detail: res.reason,
      });
    }
  }
}

async function macQuitAndInstall(): Promise<{ ok: boolean; reason?: string }> {
  // Idempotent: the native prompt and the renderer toast are both live in
  // the 'ready' state — a second click must not spawn a second swap script
  // racing the first over the same bundle.
  if (macInstallStarted) return { ok: true };
  const fail = (reason: string): { ok: false; reason: string } => {
    // The toast discards quitAndInstall's return value — broadcast so the
    // failure is visible on that path too.
    broadcastUpdaterStatus({ state: 'error', error: reason });
    return { ok: false, reason };
  };
  if (!macUpdateAppPath || !fs.existsSync(macUpdateAppPath)) return fail('No downloaded update — download it again.');
  const appBundle = macAppBundlePath();
  if (appBundle.includes('/AppTranslocation/')) {
    return fail('Move Topics.app to /Applications first, then update again.');
  }
  // Fail BEFORE quitting if we can't actually replace the bundle.
  try {
    fs.accessSync(appBundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(appBundle), fs.constants.W_OK);
  } catch {
    return fail(`No write permission for ${appBundle}`);
  }
  // Set the latch BEFORE the awaits below — a second click (dialog + toast
  // are both live) must not reach the spawn while this call is in flight.
  macInstallStarted = true;
  const oldBundle = `${appBundle}.old-${process.pid}`;
  const swapScript = path.join(app.getPath('temp'), `topics-swap-${process.pid}.sh`);
  // The swap MUST happen after this process exits (the bundle's binary is
  // running), hence the detached script. Paths travel as ARGV — never
  // interpolated into the script body, where a quote/backtick/$ in a folder
  // name would re-tokenize the commands (or execute them). Both mvs are
  // same-device renames (the new bundle was staged as a sibling), so a
  // failure can't leave a half-copied bundle; on failure the old bundle is
  // restored and relaunched, so the user is never left app-less.
  try {
    fs.writeFileSync(swapScript, `#!/bin/bash
# $1 = installed .app   $2 = backup path   $3 = staged new .app   $4 = app pid
while /bin/kill -0 "$4" 2>/dev/null; do /bin/sleep 0.2; done
/bin/mv "$1" "$2" || { /usr/bin/open -n "$1"; exit 1; }
if ! /bin/mv "$3" "$1"; then
  /bin/rm -rf "$1"
  /bin/mv "$2" "$1"
  /usr/bin/open -n "$1"
  exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$1" 2>/dev/null
/usr/bin/open -n "$1"
/bin/rm -rf "$2" "$3"
/bin/rm -f -- "$0"
`, { mode: 0o755 });
    const { spawn } = await import('child_process');
    spawn('/bin/bash', [swapScript, appBundle, oldBundle, macUpdateAppPath, String(process.pid)],
      { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    macInstallStarted = false; // nothing spawned — allow a retry
    return fail((err as Error)?.message || String(err));
  }
  (app as unknown as { isQuitting: boolean }).isQuitting = true;
  app.quit();
  return { ok: true };
}

/** Sweep leftovers from interrupted/"Later"-abandoned updates: stale
 *  `Topics.app.new-<pid>` / `.old-<pid>` siblings from previous runs. */
function macSweepUpdateLeftovers(): void {
  try {
    const appBundle = macAppBundlePath();
    const dir = path.dirname(appBundle);
    const base = path.basename(appBundle); // "Topics.app"
    const leftover = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(new|old)-\\d+$`);
    for (const name of fs.readdirSync(dir)) {
      if (leftover.test(name)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort */ }
}

async function setupAutoUpdater() {
  if (!app.isPackaged) {
    // electron-updater is a no-op in dev builds; we keep the IPC surface
    // alive so the renderer can still call it without crashing.
    return;
  }
  // Sweep regardless of signing: once builds graduate to Developer ID +
  // electron-updater, stale .new-/.old- siblings from the unsigned era
  // still deserve cleanup.
  if (process.platform === 'darwin') macSweepUpdateLeftovers();
  if (process.platform === 'darwin' && !(await isMacAppProperlySigned())) {
    // Unsigned/ad-hoc build → Squirrel.Mac would hard-fail; use the custom
    // path. Same opt-in shape: one silent metadata check after a 30 s grace,
    // everything else user-initiated through the same IPC handlers.
    macCustomActive = true;
    updaterReady = true;
    console.log('[Updater] mac build not Developer-ID signed — using self-managed update flow');
    setTimeout(() => {
      macCheckForUpdates().catch((err) =>
        broadcastUpdaterStatus({ state: 'error', error: (err as Error)?.message || String(err) }));
    }, 30_000);
    return;
  }
  try {
    const { autoUpdater } = await import('electron-updater');
    // ─── Opt-in flags ────────────────────────────────────────────────
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => broadcastUpdaterStatus({ state: 'checking' }));
    autoUpdater.on('update-available', () => broadcastUpdaterStatus({ state: 'update-available' }));
    autoUpdater.on('update-not-available', () => broadcastUpdaterStatus({ state: 'idle' }));
    autoUpdater.on('download-progress', (p: { percent?: number }) =>
      broadcastUpdaterStatus({ state: 'downloading', progress: p?.percent }));
    autoUpdater.on('update-downloaded', () => broadcastUpdaterStatus({ state: 'ready' }));
    // Native restart prompt — fires alongside the renderer toast 'ready' state.
    autoUpdater.on('update-downloaded', async (info: { version?: string }) => {
      const { dialog } = await import('electron');
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart & Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: 'A new version of Topics is ready',
        detail: `Version ${info?.version ?? ''} has been downloaded. Restart to install it now?`,
      });
      if (response === 0) {
        // Bypass the before-quit hide-trap so the installer can run.
        (app as unknown as { isQuitting: boolean }).isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      }
    });
    autoUpdater.on('error', (err: Error) =>
      broadcastUpdaterStatus({ state: 'error', error: err?.message || String(err) }));

    updaterReady = true;

    // ONE silent metadata-only check 30 s after launch. With autoDownload
    // disabled this only fires `update-available` (no download), so the
    // UI can present the "Download update" CTA. NEVER repeats — any
    // subsequent check is user-initiated via IPC.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => { /* surfaced via 'error' */ });
    }, 30_000);
  } catch (err) {
    console.warn('[Updater] electron-updater unavailable:', err);
  }
}
setupAutoUpdater();

ipcMain.handle('updater:check-for-updates', async () => {
  if (!updaterReady) return { ok: false, reason: 'not-ready' };
  try {
    if (macCustomActive) {
      await macCheckForUpdates();
      return { ok: true };
    }
    const { autoUpdater } = await import('electron-updater');
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
});

ipcMain.handle('updater:status', async () => lastUpdaterStatus);

// Explicit download trigger — gated behind a user click in the toast.
// With `autoDownload: false` this is the ONLY path that actually fetches
// the new binary.
ipcMain.handle('updater:download-update', async () => {
  if (!updaterReady) return { ok: false, reason: 'not-ready' };
  try {
    if (macCustomActive) {
      await macDownloadUpdate();
      return { ok: true };
    }
    const { autoUpdater } = await import('electron-updater');
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
});

ipcMain.handle('updater:quit-and-install', async () => {
  if (!updaterReady) return { ok: false, reason: 'not-ready' };
  try {
    if (macCustomActive) return await macQuitAndInstall();
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.quitAndInstall(false /* isSilent */, true /* isForceRunAfter */);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
});

// ─── Phase E.2 · Native "Check for Updates" + bundled server lifecycle ─────
//
// Everything below is ADDITIVE and guarded by app.isPackaged, so the dev
// flow (Vite HMR + the LaunchAgent/start-prod.sh prod scripts, where
// app.isPackaged === false and/or DEV_URL is set) is completely untouched.

/** Manual "Check for Updates…" handler, wired to the Help menu. */
async function checkForUpdatesManual(): Promise<void> {
  const { dialog } = await import('electron');
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Updates are disabled in development builds.',
      detail: `You are running Topics ${app.getVersion()} from source.`,
    });
    return;
  }
  try {
    const current = app.getVersion();
    let latest: string | undefined;
    if (macCustomActive) {
      const res = await macCheckForUpdates();
      latest = res.updateAvailable ? res.version : undefined;
    } else {
      const { autoUpdater } = await import('electron-updater');
      const result = await autoUpdater.checkForUpdates();
      latest = result?.updateInfo?.version;
    }
    if (!latest || latest === current) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Topics is up to date.',
        detail: `You are on version ${current}.`,
      });
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Topics ${latest} is available`,
      detail: `You are on ${current}. Download it now? You'll be asked to restart once it's ready.`,
    });
    if (response === 0) {
      if (macCustomActive) {
        await macDownloadUpdate(); // shows its own restart prompt when ready
      } else {
        const { autoUpdater } = await import('electron-updater');
        await autoUpdater.downloadUpdate();
      }
    }
  } catch (err: any) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'Update check failed',
      detail: err?.message || String(err),
    });
  }
}

// ── Bundled server child (packaged builds only) ────────────────────────────
// On a clean machine the user has no `bun` and no LaunchAgent, so the packaged
// app ships its own bun runtime + server source under Resources/server (see
// electron-builder `extraResources`) and spawns it here. In dev this is a
// no-op: the server is owned by `bun run dev:server` / start-prod.sh.

const SERVER_PORT = Number(process.env.PORT) || 3333;
let serverChild: import('child_process').ChildProcess | null = null;
// Crash-restart backoff: respawn the bundled server if it dies abnormally, but
// cap restarts within a window so a crash-loop doesn't spin forever.
const SERVER_RESTART_MAX = 5;
const SERVER_RESTART_WINDOW_MS = 60_000;
let serverRestartCount = 0;
let serverRestartWindowStart = 0;

function resolveServerRuntime(): { serverDir: string; binDir: string; bunPath: string } {
  const serverDir = path.join(process.resourcesPath, 'server');
  const binDir = path.join(serverDir, 'bin');
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  return { serverDir, binDir, bunPath: path.join(binDir, bunName) };
}

/** Is something already serving on the TLS port? (legacy LaunchAgent or a
 *  separately-started server) — if so we reuse it instead of double-binding. */
function serverAlreadyUp(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(
      { host: '127.0.0.1', port: SERVER_PORT, path: '/', method: 'HEAD', timeout: timeoutMs, rejectUnauthorized: false },
      (res) => { res.resume(); req.destroy(); resolve(true); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function waitForServer(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await serverAlreadyUp()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 500);
    };
    void tick();
  });
}

async function startBundledServer(): Promise<void> {
  // Dev / external-server guard — only manage a server in a packaged build
  // with no externally-provided URL.
  if (!app.isPackaged || process.env.DEV_URL) return;

  if (await serverAlreadyUp(1500)) {
    console.log('[Server] Port already served — reusing existing server');
    return;
  }

  const { serverDir, binDir, bunPath } = resolveServerRuntime();
  if (!fs.existsSync(bunPath)) {
    console.error('[Server] Bundled bun runtime missing:', bunPath);
    return;
  }

  // A freshly-DOWNLOADED unsigned app has the `com.apple.quarantine` xattr on
  // EVERY nested file, and macOS Gatekeeper SIGKILLs a quarantined executable
  // the moment it's exec'd — so the bundled `bun`/`node` would be killed and
  // the server would never come up (the #1 reason "the installed app won't
  // open"). Best-effort strip the quarantine from our own bundled runtime so it
  // can run. No-op when already clear, signed, or not permitted. Async so it
  // never blocks the event loop (the window is already on screen).
  if (process.platform === 'darwin') {
    try {
      const { execFile } = await import('child_process');
      await new Promise<void>((resolve) => {
        execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', serverDir],
          { timeout: 8000 }, () => resolve());
      });
    } catch { /* best effort */ }
  }

  // extraResources copies can drop the +x bit — restore it best-effort so the
  // bundled bun/node and node-pty's spawn-helper stay executable.
  if (process.platform !== 'win32') {
    for (const f of ['bun', 'node']) {
      try { fs.chmodSync(path.join(binDir, f), 0o755); } catch { /* best effort */ }
    }
    try {
      const helper = path.join(serverDir, 'node_modules', 'node-pty', 'prebuilds',
        `${process.platform}-${process.arch}`, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    } catch { /* best effort */ }
  }

  const { spawn } = await import('child_process');
  console.log('[Server] Spawning bundled server:', bunPath, 'in', serverDir);
  serverChild = spawn(bunPath, ['run', path.join(serverDir, 'server.ts')], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      // server/pty-bridge.mjs is spawned as `node …`; put the bundled node on
      // PATH so embedded terminals work with no system node installed.
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
  });
  serverChild.stdout?.on('data', (d) => console.log('[server]', String(d).trimEnd()));
  serverChild.stderr?.on('data', (d) => console.error('[server]', String(d).trimEnd()));
  serverChild.on('error', (err) => console.error('[Server] spawn error:', err));
  serverChild.on('exit', (code, sig) => {
    console.error(`[Server] child exited code=${code} sig=${sig}`);
    serverChild = null;
    // Don't respawn on a clean exit or while the app is quitting.
    const quitting = (app as unknown as { isQuitting: boolean }).isQuitting;
    const abnormal = code !== 0 || sig != null;
    if (quitting || !abnormal) return;
    const now = Date.now();
    if (now - serverRestartWindowStart > SERVER_RESTART_WINDOW_MS) {
      serverRestartWindowStart = now;
      serverRestartCount = 0;
    }
    if (serverRestartCount >= SERVER_RESTART_MAX) {
      console.error(`[Server] restart cap (${SERVER_RESTART_MAX}/${SERVER_RESTART_WINDOW_MS}ms) reached — not respawning. The renderer will surface connection errors.`);
      return;
    }
    serverRestartCount++;
    const delay = Math.min(500 * 2 ** (serverRestartCount - 1), 8000);
    console.error(`[Server] respawning in ${delay}ms (attempt ${serverRestartCount}/${SERVER_RESTART_MAX})`);
    // Reuse startBundledServer: its serverAlreadyUp() guard no-ops if something
    // else is already serving, and the quarantine-strip / chmod steps are
    // idempotent. Skip if a quit started during the backoff.
    setTimeout(() => {
      if (!(app as unknown as { isQuitting: boolean }).isQuitting) void startBundledServer();
    }, delay);
  });

  const healthy = await waitForServer(30_000);
  if (!healthy) {
    const { dialog } = await import('electron');
    await dialog.showMessageBox({
      type: 'error',
      message: 'Topics server failed to start',
      detail: 'The bundled server did not become ready within 30 seconds. Please relaunch the app.',
    });
  }
}

/** Stop the bundled server child. Idempotent. SIGTERM lets server.ts flush
 *  Claude children and release its singleton lock. */
function stopBundledServer(): void {
  if (!serverChild || serverChild.killed) { serverChild = null; return; }
  try {
    serverChild.kill('SIGTERM');
  } catch (e) {
    console.warn('[Server] kill failed:', e);
  }
  serverChild = null;
}
