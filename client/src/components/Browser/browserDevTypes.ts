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
