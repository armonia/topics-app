import {
  app, BrowserWindow, BrowserView, WebContentsView, ipcMain, Menu, Tray,
  nativeImage, shell, session, Notification,
  type NativeImage, type MenuItemConstructorOptions, type MenuItem,
} from 'electron';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import WebSocket from 'ws';
import { initOverlayManager, showMenu as showOverlayMenu } from './overlay-manager';

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
  const url = new URL(urlPath, SERVER_URL || 'https://localhost:3333');
  const mod = url.protocol === 'https:' ? https : http;
  return mod.get(url.href, { agent: url.protocol === 'https:' ? httpAgent : undefined }, callback);
}

function serverRequest(urlPath: string, options: http.RequestOptions = {}) {
  const url = new URL(urlPath, SERVER_URL || 'https://localhost:3333');
  const mod = url.protocol === 'https:' ? https : http;
  return mod.request(url.href, { ...options, agent: url.protocol === 'https:' ? httpAgent : undefined });
}

let mainWindow: BrowserWindow | null = null;
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

// Server URL - use DEV_URL env var for hot reload development
const SERVER_URL = process.env.DEV_URL || 'https://localhost:3333';
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

  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
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
  const topicSession = session.fromPartition(partitionId, { cache: true });

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
    // Phase G: vibrancy material on macOS so the chrome can layer over
    // a translucent background. Renderer tokens with `/ .7` alpha
    // surface the material through.
    ...(isMac ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const } : {}),
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

  mainWindow.loadURL(SERVER_URL);

  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[Topics Electron] Topics loaded, showing window');
    mainWindow!.show();
  });

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

  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[Topics Electron] Failed to load:', code, desc);
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

function startWSBridge(): void {
  if (trayWS) return;
  const wsUrl = SERVER_URL.replace(/^http/, 'ws') + '/ws';
  console.log('[Topics Electron] WS bridge connecting to', wsUrl);

  try {
    trayWS = new WebSocket(wsUrl, { rejectUnauthorized: false });
  } catch (err: unknown) {
    console.error('[Topics Electron] WS bridge connection error:', (err as Error).message);
    scheduleWSReconnect();
    return;
  }

  trayWS.on('open', () => {
    console.log('[Topics Electron] WS bridge connected');
    wsReconnectDelay = 1000;
    fetchTopicCache();
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
    console.log('[Topics Electron] WS bridge disconnected');
    trayWS = null;
    scheduleWSReconnect();
  });

  trayWS.on('error', (err) => {
    console.error('[Topics Electron] WS bridge error:', err.message);
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

    case 'message':
      if (msg.sessionKey && msg.message) {
        handleNewMessage(msg);
      }
      break;

    case 'approval:created':
      notifyApproval(msg);
      break;

    case 'pong':
      break;
  }
}

// ============ Topic Cache ============

function fetchTopicCache(): void {
  const req = serverGet('/api/topics', (res) => {
    let data = '';
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
  if (totalUnread > 0) {
    tray.setToolTip(`${appLabel} (${totalUnread} unread)`);
  } else {
    tray.setToolTip(appLabel);
  }
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

  if (totalUnread > 0) {
    tray.setImage(trayIcons.unread!);
    tray.setTitle(String(totalUnread), { fontType: 'monospacedDigit' });
  } else if (!trayState.gatewayConnected) {
    tray.setImage(trayIcons.disconnected!);
    tray.setTitle('');
  } else {
    tray.setImage(trayIcons.normal);
    tray.setTitle('');
  }
}

function updateDockBadge(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const totalUnread = getTotalUnread();
  if (totalUnread > 0) {
    app.dock.setBadge(String(totalUnread));
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

// ============ Notification Triggers ============

function handleNewMessage(msg: WSMessage): void {
  const topicId = msg.sessionKey?.replace('topic:', '');
  if (!topicId) return;

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && trayState.focusedTopicId === topicId) {
    return;
  }

  if (isTopicOnCooldown(topicId)) return;
  setTopicCooldown(topicId);

  const topicName = getTopicName(topicId);
  const messageText = msg.message?.content || msg.message?.text || '';
  const preview = messageText.length > 100 ? messageText.substring(0, 100) + '...' : messageText;

  showNotification({
    id: `msg-${topicId}-${Date.now()}`,
    title: topicName,
    body: preview || 'New message',
    topicId,
  });
}

function notifyAgentCompleted(session: WSMessage['sessions'] extends (infer T)[] | undefined ? T : never): void {
  const topicId = session.topic_id || session.topicId;
  const agentLabel = session.agent_id || session.agentId || 'Agent';

  // Cooldown is keyed by topic so two agents firing back-to-back on the
  // same topic don't spam the user, but parallel topics still each get
  // their cue. We always fire (we already missed the visible count for
  // years because of the old check) — focus-suppression is opt-in via
  // user setting and lives on the renderer side, not here.
  if (topicId && isTopicOnCooldown(topicId)) return;
  if (topicId) setTopicCooldown(topicId);

  const topicName = topicId ? getTopicName(topicId) : null;
  const title = topicName ? `${topicName} · agent done` : 'Agent completed';
  const body = topicName ? agentLabel : `${agentLabel} session finished`;

  showNotification({
    id: `agent-${session.id || topicId || 'x'}-${Date.now()}`,
    title,
    body,
    topicId,
  });
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
          accelerator: 'CmdOrCtrl+Shift+T',
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
  if (!entry) throw new Error(`browser-native:navigate — view ${viewId} not found`);
  if (typeof url !== 'string' || !url) throw new Error('browser-native:navigate — url required');
  await entry.view.webContents.loadURL(url);
  return {
    url: entry.view.webContents.getURL(),
    title: entry.view.webContents.getTitle(),
  };
});

ipcMain.handle('browser-native:go-back', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:go-back — view ${viewId} not found`);
  const nav = (entry.view.webContents as unknown as { navigationHistory?: { goBack(): void } }).navigationHistory;
  if (nav?.goBack) nav.goBack();
  else (entry.view.webContents as unknown as { goBack(): void }).goBack?.();
});

ipcMain.handle('browser-native:go-forward', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:go-forward — view ${viewId} not found`);
  const nav = (entry.view.webContents as unknown as { navigationHistory?: { goForward(): void } }).navigationHistory;
  if (nav?.goForward) nav.goForward();
  else (entry.view.webContents as unknown as { goForward(): void }).goForward?.();
});

ipcMain.handle('browser-native:reload', async (_evt, viewId: string): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:reload — view ${viewId} not found`);
  entry.view.webContents.reload();
});

ipcMain.handle('browser-native:set-bounds', async (
  _evt, viewId: string, bounds: { x: number; y: number; width: number; height: number }
): Promise<void> => {
  const entry = nativeBrowsers.get(viewId);
  if (!entry) throw new Error(`browser-native:set-bounds — view ${viewId} not found`);
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
    items: Array<{ id: string; label: string; iconName?: string; divider?: boolean }>;
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
  // Hand-rolled XML keeps the dep tree small and the output diff-friendly.
  // We escape *paths* (the only externally-influenced field) by relying on
  // the fact that we control them server-side: serverDir comes from
  // app.getAppPath(), bunPath from `which bun`.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${path.join(serverDir, 'server.ts')}</string>
  </array>
  <key>WorkingDirectory</key><string>${serverDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${logsPath}</string>
  <key>StandardErrorPath</key><string>${logsPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>HOME</key><string>${process.env.HOME || ''}</string>
    <key>PATH</key><string>${path.dirname(bunPath)}:/usr/local/bin:/usr/bin:/bin</string>
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
  if (win && !win.isDestroyed()) {
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

let assetWatcher: fs.FSWatcher | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function startAssetWatcher(): void {
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
    assetWatcher = fs.watch(publicDir, { recursive: true }, (_eventType, filename) => {
      if (filename !== 'index.html') return;
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        console.log(`[Topics Electron] index.html updated, reloading...`);
        reloadAllAppWindows();
      }, 500);
    });

    console.log('[Topics Electron] Asset watcher started on /public/index.html');
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
  if (assetWatcher) {
    assetWatcher.close();
    assetWatcher = null;
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

app.whenReady().then(() => {
  if (isDev && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
    app.setName('Topics DEV');
  }

  const prefs = loadPreferences();
  alwaysOnTop = prefs.alwaysOnTop || false;

  createAppMenu();
  // Phase 30.1 polish — overlay manager IPC handlers register here.
  initOverlayManager();
  createWindow();
  createTray();
  startWSBridge();
  startNotificationCleanup();
  startCDPInfoServer();
  startAssetWatcher();

  if (alwaysOnTop && mainWindow) {
    mainWindow.setAlwaysOnTop(true, 'floating');
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

app.on('will-quit', () => {
  stopWSBridge();
  stopNotificationCleanup();
  stopAssetWatcher();
  // Phase 30.1 — destroy any native browser views still alive.
  for (const viewId of nativeBrowsers.keys()) {
    try { destroyNativeBrowser(viewId); } catch { /* best effort */ }
  }
});

// Allow self-signed TLS certificates for localhost
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', '');
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  if (new URL(url).hostname === 'localhost') {
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

// Clean up on quit.
app.on('before-quit', () => {
  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch {}
    caffeinateProc = null;
  }
});

// ─── Phase E · Auto-update (electron-updater) ──────────────────────────────
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
const RETRY_BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

function broadcastUpdaterStatus(status: typeof lastUpdaterStatus) {
  lastUpdaterStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:status', status);
    }
  }
}

async function setupAutoUpdater() {
  if (!app.isPackaged) {
    // electron-updater is a no-op in dev builds; we keep the IPC surface
    // alive so the renderer can still call it without crashing.
    return;
  }
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => broadcastUpdaterStatus({ state: 'checking' }));
    autoUpdater.on('update-available', () => broadcastUpdaterStatus({ state: 'update-available' }));
    autoUpdater.on('update-not-available', () => broadcastUpdaterStatus({ state: 'idle' }));
    autoUpdater.on('download-progress', (p: { percent?: number }) =>
      broadcastUpdaterStatus({ state: 'downloading', progress: p?.percent }));
    autoUpdater.on('update-downloaded', () => broadcastUpdaterStatus({ state: 'ready' }));
    autoUpdater.on('error', (err: Error) =>
      broadcastUpdaterStatus({ state: 'error', error: err?.message || String(err) }));

    updaterReady = true;

    // Background check + retry backoff. We don't `throw` from the chain —
    // electron-updater emits 'error' which we already capture.
    let attempt = 0;
    const tryCheck = () => {
      autoUpdater.checkForUpdates().catch(() => {});
      const next = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      attempt++;
      setTimeout(tryCheck, next);
    };
    setTimeout(tryCheck, 10_000); // first check 10 s after startup
  } catch (err) {
    console.warn('[Updater] electron-updater unavailable:', err);
  }
}
setupAutoUpdater();

ipcMain.handle('updater:check-for-updates', async () => {
  if (!updaterReady) return { ok: false, reason: 'not-ready' };
  try {
    const { autoUpdater } = await import('electron-updater');
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
});

ipcMain.handle('updater:status', async () => lastUpdaterStatus);

ipcMain.handle('updater:quit-and-install', async () => {
  if (!updaterReady) return { ok: false, reason: 'not-ready' };
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.quitAndInstall(false /* isSilent */, true /* isForceRunAfter */);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
});
