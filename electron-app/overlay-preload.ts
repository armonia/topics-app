/**
 * Phase 30.1 polish — Preload script for overlay BrowserWindow.
 *
 * Bridges IPC between the overlay renderer (overlay-renderer.ts) and
 * the main process. Distinct from the main app preload since the
 * overlay is a totally separate window with its own renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

interface OverlayMenuInitPayload {
  items: Array<{ id: string; label: string; iconName?: string; divider?: boolean }>;
  theme: 'light' | 'dark';
  requestId: string;
}

contextBridge.exposeInMainWorld('electronOverlayBridge', {
  onInit: (handler: (init: OverlayMenuInitPayload) => void) => {
    ipcRenderer.on('overlay:init', (_evt, payload: OverlayMenuInitPayload) => {
      handler(payload);
    });
  },
  sendSelect: (requestId: string, itemId: string) => {
    ipcRenderer.send('overlay:select', requestId, itemId);
  },
  sendCancel: (requestId: string) => {
    ipcRenderer.send('overlay:cancel', requestId);
  },
});
