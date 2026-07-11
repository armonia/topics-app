/**
 * Shared types for the browser dev-toolbar features (device emulation, quick
 * console, nav history). Kept in one place so the hook (useNativeBrowser), the
 * toolbar, and the small sub-components agree on the shapes.
 */

/** Device-emulation presets surfaced in the toolbar switcher. */
export type DeviceMode = 'desktop' | 'mobile' | 'tablet' | 'auto' | 'custom';

/** A device preset's metrics + UA. `desktop`/`auto` carry no metrics (disable
 *  emulation / fit-the-pane respectively); mobile/tablet/custom carry a size. */
export interface DevicePreset {
  mode: DeviceMode;
  label: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DEVICE_PRESETS: Record<Exclude<DeviceMode, 'custom'>, DevicePreset> = {
  desktop: { mode: 'desktop', label: 'Desktop' },
  auto: { mode: 'auto', label: 'Auto' },
  mobile: { mode: 'mobile', label: 'Mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true, userAgent: IPHONE_UA },
  tablet: { mode: 'tablet', label: 'Tablet', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, userAgent: IPAD_UA },
};

/** A console entry forwarded from the native view (main.ts wc.on('console-message')). */
export interface BrowserConsoleEntry {
  /** Monotonic id for stable React keys + de-dup. */
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  /** "file.js:42" when Chromium provides it. */
  source?: string;
}

/** One entry of the page's back/forward navigation history. */
export interface NavHistoryEntry {
  url: string;
  title: string;
  index: number;
}

/**
 * Handle returned by the native browser hook (`useTauriBrowser`) and consumed by
 * `NativeBrowserPlaceholder` + `RemoteBrowserPanel`'s Tauri path. Kept here (a
 * neutral, host-agnostic types module) so it survives the removal of the archived
 * Electron `useNativeBrowser` hook that originally declared it.
 */
export interface NativeBrowserHandle {
  url: string;
  title: string;
  loading: boolean;
  agentActive: boolean;
  /** Human-readable label of the agent's current action ("Clicca", "Naviga su
   *  example.com", …). Last value seen on agent_active=true; persists through the
   *  brief idle linger so a burst of tool calls shows steady text. */
  agentAction: string | null;
  ready: boolean;             // native webview opened (browser_open resolved)
  viewId: string | null;
  /** Optional — Tauri only. A base64 PNG data-URL still of the page, shown in the
   *  placeholder while the native WKWebView is parked off-screen (a dropdown/menu
   *  overlaps it, or a sidebar/divider animation is in flight). A native child
   *  webview always composites ABOVE the DOM, so it can't be z-ordered under an
   *  HTML overlay nor cheaply moved per-frame; freezing to a DOM <img> lets
   *  overlays render over a pixel-perfect still and lets animations move the image,
   *  not the native view. */
  frozenImage?: string | null;
  /** Favicon URL emitted by the page. Empty during navigation. */
  faviconUrl: string;
  /** Optional — Tauri only. Last navigation failure (WKNavigationDelegate
   *  did-fail, drained from the Rust queue). Cleared by the next navigate()
   *  or by clearNavError(). Null on the web path (it has its own WS channel). */
  navError?: { message: string; url: string } | null;
  /** Optional — dismiss the navigation-error strip without navigating. */
  clearNavError?(): void;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  goHome(): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  toggleDevTools(): Promise<void>;
  /** Find in page (Cmd+F). Pass empty string + findNext=false to clear. */
  findInPage(text: string, options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }): Promise<void>;
  stopFind(): Promise<void>;
  /** Optional — count case-insensitive matches of `text` in the page (Tauri pane,
   *  where window.find gives no count). */
  countMatches?(text: string): Promise<number>;
  /** Optional — inspect the element at page CSS coords (Tauri select-element). */
  inspectAt?(x: number, y: number): Promise<{
    cssPath: string;
    domPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text: string;
  } | null>;
  /** Optional — Cmd+Shift+E select-element. On the Tauri pane the picking runs
   *  IN-PAGE (the native view sits above the DOM, so a React overlay can't catch
   *  the click); the hook dispatches `chat:insert-text` with the picked node. */
  selectMode?: boolean;
  enterSelectMode?(): void;
  exitSelectMode?(): void;
  /** Zoom (Cmd+/-/0). Only the sign of `delta` matters (one ladder notch);
   *  'reset' → 100%. Returns the new zoom percentage (a clean integer). */
  setZoom(delta: number | 'reset'): Promise<number>;
  /** Current zoom percentage (clean integer on the ZOOM_STEPS ladder, default 100).
   *  Reactive source of truth for the toolbar label so button + keyboard agree. */
  zoom: number;
  /** Current device-emulation mode (default 'desktop'). */
  deviceMode: DeviceMode;
  /** Apply a device preset. 'mobile'/'tablet' emulate; 'custom' = responsive
   *  resize (real view sized to width/height, no emulation); 'desktop'/'auto'
   *  fill the pane. */
  setDevice(mode: DeviceMode, custom?: { width: number; height: number; deviceScaleFactor?: number }): void;
  /** Responsive-resize viewport (px) when deviceMode==='custom'; null otherwise. */
  responsiveSize: { width: number; height: number } | null;
  /** Live-set the responsive viewport (called continuously while dragging a handle). */
  setResponsiveSize(width: number, height: number): void;
  /** Recent page console messages (ring buffer) for the toolbar quick-console. */
  consoleEntries: BrowserConsoleEntry[];
  /** Counts for the toolbar badge. */
  consoleSummary: { errors: number; warnings: number };
  clearConsole(): void;
  /** Fetch the back/forward navigation history for the Chrome-style menu. */
  getNavEntries(): Promise<{ entries: NavHistoryEntry[]; activeIndex: number }>;
  goToNavIndex(index: number): Promise<void>;
}
