/**
 * Overlay host — render full-screen React modals (⌘K, Settings, …) ABOVE the
 * native browser pane.
 *
 * A browser pane is an OS-level `WebContentsView` composited above the main
 * window's DOM, so a modal rendered in the main renderer is painted UNDER it.
 * overlay-manager.ts already solves this for simple MENUS (a transparent
 * always-on-top window). Full modals can't be expressed as a menu, so this is
 * the richer sibling: ONE persistent transparent always-on-top child window,
 * tracking the parent's content bounds, that loads the app in "overlay mode"
 * (`?overlay=1`) and renders the requested modal.
 *
 * Data + actions cross the window boundary by value, not by sharing state:
 *   - show(payload): the main renderer passes a snapshot (e.g. ⌘K's topics /
 *     projects / closed tabs) — the modal is transient, a snapshot is enough.
 *   - the overlay relays every modal action back through ONE generic channel
 *     (`overlay-host:action {type,args}`); the main renderer invokes the real
 *     callback. No 12 hand-written bridges, no second WS/store in the overlay.
 *
 * Idle = hidden (no click interference). Shown only while a modal is up.
 */
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

let hostWin: BrowserWindow | null = null;
let parentRef: BrowserWindow | null = null;
let appUrl = '';
let loaded = false;
let ipcWired = false;

function overlayUrl(): string {
  return appUrl + (appUrl.includes('?') ? '&' : '?') + 'overlay=1';
}

function syncBounds(): void {
  if (!hostWin || hostWin.isDestroyed() || !parentRef || parentRef.isDestroyed()) return;
  try { hostWin.setBounds(parentRef.getContentBounds()); } catch { /* ignore */ }
}

function ensureWin(): BrowserWindow {
  if (hostWin && !hostWin.isDestroyed()) return hostWin;
  hostWin = new BrowserWindow({
    parent: parentRef ?? undefined,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  // Idle: forward mouse so the transparent shell never eats clicks (defensive —
  // we also hide it when idle, but show/hide can race a stray pointer event).
  hostWin.setIgnoreMouseEvents(true, { forward: true });
  loaded = false;
  hostWin.webContents.once('did-finish-load', () => { loaded = true; });
  hostWin.loadURL(overlayUrl()).catch(() => { /* retried on next show */ });
  syncBounds();
  return hostWin;
}

function showModal(payload: unknown): void {
  const win = ensureWin();
  syncBounds();
  win.setIgnoreMouseEvents(false);
  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('overlay-host:render', payload); };
  if (loaded) send();
  else win.webContents.once('did-finish-load', send);
  if (!win.isVisible()) win.show();
  win.focus();
}

function hideModal(): void {
  if (!hostWin || hostWin.isDestroyed()) return;
  try {
    hostWin.webContents.send('overlay-host:render', null);
    hostWin.setIgnoreMouseEvents(true, { forward: true });
    hostWin.hide();
  } catch { /* ignore */ }
}

/**
 * Wire the overlay host to the main window. Call once after the main window is
 * created. `url` is the same URL the main window loads (SERVER_URL / DEV_URL).
 */
export function initOverlayHost(parent: BrowserWindow, url: string): void {
  parentRef = parent;
  appUrl = url;

  // Geometry listeners attach to the CURRENT parent every call — a recreated
  // window gets fresh ones, and the old window's listeners die with it.
  const sync = () => syncBounds();
  parent.on('move', sync);
  parent.on('resize', sync);
  parent.on('enter-full-screen', sync);
  parent.on('leave-full-screen', sync);
  parent.on('restore', sync);
  parent.on('show', sync);
  parent.on('closed', () => {
    if (hostWin && !hostWin.isDestroyed()) hostWin.destroy();
    hostWin = null;
  });

  // ipcMain handlers are process-global — register ONLY once, or a recreated
  // main window (same process) would stack them and fire N times.
  if (ipcWired) return;
  ipcWired = true;

  // Main renderer → host.
  ipcMain.on('overlay-host:show', (_e, payload) => showModal(payload));
  ipcMain.on('overlay-host:hide', () => hideModal());

  // Overlay renderer → relay to main renderer.
  ipcMain.on('overlay-host:action', (e, action) => {
    // Only the overlay window may relay; ignore anything from the main window.
    if (hostWin && !hostWin.isDestroyed() && e.sender === hostWin.webContents) {
      if (parentRef && !parentRef.isDestroyed()) parentRef.webContents.send('overlay-host:action', action);
    }
  });

  // Overlay closed itself (Esc / backdrop) → hide + tell main to clear its flag.
  ipcMain.on('overlay-host:closed', (e) => {
    if (hostWin && !hostWin.isDestroyed() && e.sender === hostWin.webContents) {
      hideModal();
      if (parentRef && !parentRef.isDestroyed()) parentRef.webContents.send('overlay-host:closed');
    }
  });
}
