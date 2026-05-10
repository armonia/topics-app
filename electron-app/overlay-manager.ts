/**
 * Phase 30.1 polish — Overlay window manager.
 *
 * Solves the OS-level WebContentsView vs DOM dropdown conflict (Electron
 * #15899) by rendering popups in a separate transparent BrowserWindow
 * that ALWAYS stays above the parent window. This is the same pattern
 * used by Discord/gaming overlays and electron-overlay-window package.
 *
 * Usage from renderer:
 *   const itemId = await window.electronAPI.overlay.showMenu({
 *     anchor: { x, y, width, height },
 *     items: [{ id, label, iconName }, ...],
 *     side: 'bottom' | 'top' | 'right' | 'left',
 *   });
 *
 * Returns: id of selected item, or null if cancelled (blur, esc).
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';

interface OverlayMenuItem {
  id: string;
  label: string;
  iconName?: string;
  /** Optional brand colour for the icon (CSS string, e.g. '#D97757' for
   *  Claude orange). Forwarded as-is to the overlay renderer which sets
   *  it as the SVG's currentColor. Mirrors the web menu's inline
   *  `style={{ color: cfg.color }}` on lucide icons. */
  iconColor?: string;
  divider?: boolean;
}

interface ShowMenuOptions {
  /** Anchor rect in renderer's CSS pixels (relative to parent window content). */
  anchor: { x: number; y: number; width: number; height: number };
  items: OverlayMenuItem[];
  side?: 'bottom' | 'top' | 'right' | 'left';
  theme?: 'light' | 'dark';
  /** Estimated panel size for sizing the overlay window. */
  estimatedWidth?: number;
  estimatedItemHeight?: number;
  /** Pixel gap between anchor and panel (default: 4). */
  gap?: number;
  /** CSS color overrides applied via CSS variables in the overlay. */
  colors?: { bg?: string; text?: string; muted?: string; border?: string; hover?: string };
}

interface PendingRequest {
  resolve: (itemId: string | null) => void;
  win: BrowserWindow;
  requestId: string;
}

const pending = new Map<string, PendingRequest>();
let initialized = false;

export function initOverlayManager(): void {
  if (initialized) return;
  initialized = true;

  // Renderer overlay reports a click — resolve & close.
  ipcMain.on('overlay:select', (_evt, requestId: string, itemId: string) => {
    const req = pending.get(requestId);
    if (!req) return;
    req.resolve(itemId);
    closeOverlay(requestId);
  });

  // Renderer overlay reports cancel (esc).
  ipcMain.on('overlay:cancel', (_evt, requestId: string) => {
    const actualId = requestId === '__current__' ? lastRequestId() : requestId;
    if (!actualId) return;
    const req = pending.get(actualId);
    if (!req) return;
    req.resolve(null);
    closeOverlay(actualId);
  });
}

function lastRequestId(): string | null {
  // Map preserves insertion order — last entry == most recently opened.
  let last: string | null = null;
  for (const k of pending.keys()) last = k;
  return last;
}

function closeOverlay(requestId: string) {
  const req = pending.get(requestId);
  if (!req) return;
  pending.delete(requestId);
  if (!req.win.isDestroyed()) req.win.destroy();
}

export async function showMenu(
  parent: BrowserWindow,
  opts: ShowMenuOptions,
): Promise<string | null> {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Estimate overlay panel size.
  const itemH = opts.estimatedItemHeight ?? 28;
  const dividerCount = opts.items.filter(i => i.divider).length;
  const estH = opts.items.length * itemH + dividerCount * 9 /* divider height + margins */ + 8 /* panel padding */;
  const estW = opts.estimatedWidth ?? 200;

  // Compute screen coordinates from renderer CSS pixels.
  // anchor is in renderer-local coordinates; convert to screen coords.
  const parentBounds = parent.getContentBounds();
  const display = screen.getDisplayNearestPoint({ x: parentBounds.x, y: parentBounds.y });
  const scale = display.scaleFactor;
  void scale; // BrowserWindow APIs use CSS pixels on Mac/Linux; keep var for future per-platform tweaks.

  const side = opts.side ?? 'bottom';
  const gap = opts.gap ?? 4;
  let x: number;
  let y: number;
  switch (side) {
    case 'bottom':
      x = parentBounds.x + Math.round(opts.anchor.x);
      y = parentBounds.y + Math.round(opts.anchor.y + opts.anchor.height + gap);
      break;
    case 'top':
      x = parentBounds.x + Math.round(opts.anchor.x);
      y = parentBounds.y + Math.round(opts.anchor.y - estH - gap);
      break;
    case 'right':
      x = parentBounds.x + Math.round(opts.anchor.x + opts.anchor.width + gap);
      y = parentBounds.y + Math.round(opts.anchor.y);
      break;
    case 'left':
      x = parentBounds.x + Math.round(opts.anchor.x - estW - gap);
      y = parentBounds.y + Math.round(opts.anchor.y);
      break;
  }
  // Default for "bottom" side: align panel's right edge with anchor's right edge
  // so menus that open from a right-justified button stay inside the window.
  if (side === 'bottom' && opts.anchor.x + opts.anchor.width > estW) {
    x = parentBounds.x + Math.round(opts.anchor.x + opts.anchor.width - estW);
  }

  // Clamp to display bounds — overlay must not spawn off-screen.
  const workArea = display.workArea;
  x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - estW - 4));
  y = Math.max(workArea.y + 4, Math.min(y, workArea.y + workArea.height - estH - 4));

  const win = new BrowserWindow({
    parent,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: true,
    skipTaskbar: true,
    show: false,
    width: estW,
    height: estH,
    x,
    y,
    webPreferences: {
      preload: join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Click-outside / focus-loss → cancel.
  win.on('blur', () => {
    const req = pending.get(requestId);
    if (req) {
      req.resolve(null);
      closeOverlay(requestId);
    }
  });

  pending.set(requestId, {
    resolve: () => undefined,
    win,
    requestId,
  });

  return new Promise<string | null>((resolve) => {
    // Replace the placeholder resolve with the real one.
    const entry = pending.get(requestId);
    if (entry) entry.resolve = resolve;

    win.loadFile(join(__dirname, 'overlay.html'));

    win.webContents.once('did-finish-load', () => {
      win.webContents.send('overlay:init', {
        requestId,
        items: opts.items,
        theme: opts.theme ?? 'light',
        colors: opts.colors,
      });
      win.show();
      win.focus();
    });

    win.on('closed', () => {
      const r = pending.get(requestId);
      if (r) {
        // If still pending, treat closure as cancel.
        pending.delete(requestId);
        resolve(null);
      }
    });
  });
}
