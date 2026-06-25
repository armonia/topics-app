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
  /** Liveness heartbeat: keeps the native view alive between renderer churn.
   *  Resolves `false` when the view has been reaped (gone) so the renderer can
   *  recreate it and self-heal instead of pinging a dead id forever. */
  keepalive(viewId: string): Promise<boolean>;
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
  setDevice(viewId: string, params: null | { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string }): Promise<void>;
  getNavEntries(viewId: string): Promise<{ entries: { url: string; title: string; index: number }[]; activeIndex: number }>;
  goToNavIndex(viewId: string, index: number): Promise<void>;
  onConsoleMessage(viewId: string, callback: (entry: { id: number; level: string; text: string; source?: string }) => void): () => void;
  onPermissionRequest(callback: (info: { requestId: string; permission: string; url: string; partitionId: string }) => void): () => void;
  respondPermission(requestId: string, granted: boolean): void;
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
  /** A page (or the agent) called window.close() — fires with the browser pane's
   *  contextId so the renderer can close the owning pane. Returns an unsubscribe. */
  onPageCloseRequest(callback: (contextId: string) => void): () => void;
}

// Phase 30.1 polish — Overlay menu API (transparent BrowserWindow above WebContentsView).
export interface OverlayMenuItem {
  id: string;
  label: string;
  /** Predefined icon name; mapped to SVG in overlay-renderer. Unknown names
   *  render no icon. Mirrors the lucide-react icons used in the web menu so
   *  every PaneAddMenu surface — Electron overlay AND web portal — paints
   *  the same icon set (Claude logo, Shell terminal-square, Browser globe,
   *  Git git-branch, Files folder-tree, Board Memory brain). */
  iconName?:
    | 'globe'
    | 'terminal'
    | 'terminal-square'
    | 'message-square'
    | 'folder'
    | 'folder-tree'
    | 'git-branch'
    | 'brain'
    | 'file-code'
    | 'claude'
    | 'bot'
    | 'file-text'
    | 'layout'
    | 'list'
    | 'plus-square';
  /** Optional brand colour for the icon (CSS string). The overlay sets it
   *  as the SVG's currentColor, matching the web menu's
   *  `style={{ color: cfg.color }}` on lucide icons. Without this the
   *  overlay rendered everything mono-colour while the web portal showed
   *  brand-tinted icons — the two surfaces looked like different menus. */
  iconColor?: string;
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

/** A modal request rendered by the overlay host window. `data` is the modal's
 *  snapshot (e.g. ⌘K's topics/projects/closed-tabs), passed by value. */
export interface OverlayHostState {
  modal: string;
  data?: unknown;
}

/** A modal action relayed from the overlay window back to the main renderer. */
export interface OverlayHostAction {
  type: string;
  args: unknown[];
}

export interface OverlayHostAPI {
  // main-renderer side
  show(payload: OverlayHostState): void;
  hide(): void;
  onAction(cb: (action: OverlayHostAction) => void): () => void;
  onClosed(cb: () => void): () => void;
  // overlay-window side
  onRender(cb: (state: OverlayHostState | null) => void): () => void;
  action(action: OverlayHostAction): void;
  closed(): void;
}

declare global {
  interface Window {
    electronAPI?: {
      browserNative?: BrowserNativeAPI;
      overlay?: OverlayAPI;
      overlayHost?: OverlayHostAPI;
      /** Whether the page is running inside the Electron shell. Some callsites
       *  branch on this to short-circuit reload / cache-bust paths in favor
       *  of the native equivalents below. */
      isElectron?: boolean;
      /**
       * App lifecycle bridge. Currently only `relaunch()` is consumed by
       * `SidebarStatusBar` to perform a hard-restart that bypasses the
       * service worker; expand as more native commands are needed.
       */
      app?: {
        relaunch(): Promise<void>;
        getVersion?(): Promise<string>;
      };
      /**
       * Performance diagnostics bridge (Electron only). `getMetrics()` returns
       * per-process CPU and GPU-acceleration status so the status-bar dropdown
       * can attribute low FPS to the PC vs. Topics' own renderer.
       */
      perf?: {
        getMetrics(): Promise<{
          version: string;
          cpu: { renderer: number; gpu: number; total: number };
          /**
           * Per-process memory (MB) summed across every Chromium process.
           * `metric` is 'footprint' (≈ Activity Monitor: RSS + compressed + GPU,
           * macOS) or 'rss' (resident only) as the fallback.
           */
          memory: { totalMB: number; rendererMB: number; gpuMB: number; otherMB: number; processCount: number; metric: 'footprint' | 'rss' };
          gpu: { accelerated: boolean; compositing: string; webgl: string };
        }>;
      };
      // existing fields stay typed via the ad-hoc shape already used in App.tsx
      // (see client/src/types/electron.d.ts). We don't lock them down here to
      // avoid touching unrelated callsites.
      [key: string]: unknown;
    };
  }
}

export {};
