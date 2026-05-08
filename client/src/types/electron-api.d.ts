// Phase 30.1 BROWSER-CHAT-06 — Electron native browser API exposed via preload.
// Detection: `window.electronAPI?.browserNative?.isAvailable` is the runtime gate.
// Web mode: `window.electronAPI` is undefined -> falls back to Phase 30 streaming.

export interface BrowserNativeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserNativeCreateOptions {
  topicId: string;
  partitionId: string;     // e.g. "persist:topic-<topicId>"
  initialUrl?: string;     // default: 'about:blank'
}

export interface BrowserNativeCreateResult {
  viewId: string;          // opaque id mapped to WebContentsView in main
  cdpTargetId: string;     // CDP targetId for agent attach via /json/list
}

export interface BrowserNativeAPI {
  isAvailable: true;       // truthy gate; absence -> web mode
  create(opts: BrowserNativeCreateOptions): Promise<BrowserNativeCreateResult>;
  destroy(viewId: string): Promise<void>;
  navigate(viewId: string, url: string): Promise<{ url: string; title: string }>;
  goBack(viewId: string): Promise<void>;
  goForward(viewId: string): Promise<void>;
  reload(viewId: string): Promise<void>;
  setBounds(viewId: string, bounds: BrowserNativeBounds): Promise<void>;
  getCdpTargetId(viewId: string): Promise<string>;
  toggleDevTools(viewId: string, mode?: 'right' | 'bottom' | 'left' | 'undocked' | 'detach'): Promise<void>;
  onUrlChange(viewId: string, callback: (url: string) => void): () => void;
  onTitleChange(viewId: string, callback: (title: string) => void): () => void;
  onLoadingChange(viewId: string, callback: (loading: boolean) => void): () => void;
  onFaviconChange(viewId: string, callback: (faviconUrl: string) => void): () => void;
  findInPage(viewId: string, text: string, options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }): Promise<void>;
  stopFind(viewId: string): Promise<void>;
  onFindResult(viewId: string, callback: (r: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void): () => void;
  setZoom(viewId: string, delta: number | 'reset'): Promise<number>;
  onPermissionGranted(callback: (info: { permission: string; url: string; partitionId: string }) => void): () => void;
  onDownloadStart(callback: (info: { id: string; url: string; filename: string; totalBytes: number }) => void): () => void;
  onDownloadProgress(callback: (info: { id: string; state: string; received: number; total: number; isPaused: boolean }) => void): () => void;
  onDownloadDone(callback: (info: { id: string; state: string; savedPath: string }) => void): () => void;
  showDownloadInFolder(savedPath: string): Promise<void>;
  inspectAtPoint(viewId: string, x: number, y: number): Promise<null | {
    domPath: string;
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text?: string;
    attributes?: Record<string, string>;
  }>;
  onReflow(callback: () => void): () => void;
}

// Phase 30.1 polish — Overlay menu API (transparent BrowserWindow above WebContentsView).
export interface OverlayMenuItem {
  id: string;
  label: string;
  /** Predefined icon name; mapped to SVG in overlay-renderer. Unknown names render no icon. */
  iconName?: 'globe' | 'terminal' | 'message-square' | 'folder' | 'bot' | 'file-text' | 'layout' | 'list' | 'plus-square';
  divider?: boolean;
}

export interface OverlayShowMenuOptions {
  /** Anchor rect in renderer-local CSS pixels (BoundingClientRect of the trigger button). */
  anchor: { x: number; y: number; width: number; height: number };
  items: OverlayMenuItem[];
  side?: 'bottom' | 'top' | 'right' | 'left';
  theme?: 'light' | 'dark';
  estimatedWidth?: number;
  estimatedItemHeight?: number;
  /** Pixel gap between anchor and panel (default 4). */
  gap?: number;
  /** CSS color overrides applied via CSS variables in the overlay. */
  colors?: { bg?: string; text?: string; muted?: string; border?: string; hover?: string };
}

export interface OverlayAPI {
  showMenu(opts: OverlayShowMenuOptions): Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: {
      browserNative?: BrowserNativeAPI;
      overlay?: OverlayAPI;
      // existing fields stay typed via the ad-hoc shape already used in App.tsx
      // (see client/src/types/electron.d.ts). We don't lock them down here to
      // avoid touching unrelated callsites.
      [key: string]: unknown;
    };
  }
}

export {};
