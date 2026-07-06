/**
 * Phase 30.1 BROWSER-CHAT-06 — Unified browser operations surface.
 *
 * BrowserService (Playwright server-launched) implements this interface so the
 * tool handlers can target ONE shape. (The Electron connectOverCDP adapter was
 * removed with the Electron shell in v2.0.0; the Tauri native pane is driven by
 * the client-side executor via the native delegate, not through this surface.)
 *
 * `broadcastAgentActive` is excluded — it's a service-level concern (the
 * single registry) and stays a separate dep on the handler factory.
 */
import type { Page } from 'playwright-core';
import type { BrowserService } from './browser-service';
import type { IndexedElement } from './browser-tools';
import {
  snapshotPage,
  actByRefOnPage,
  getTextOnPage,
  extractFieldsOnPage,
  evalOnPage,
  type Snapshot,
  type RefAction,
  type ExtractFields,
} from './browser-snapshot';
import {
  exportStateFromContext,
  applyStateToPage,
  type StorageState,
} from './browser-login-state';

export interface BrowserOps {
  navigate(url: string): Promise<{ url: string; title: string }>;
  screenshot(opts: { format?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  dispatchInput(
    type: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
    payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number },
  ): Promise<void>;
  extractIndexedElements(opts: { maxElements?: number }): Promise<IndexedElement[]>;
  captureAnnotatedScreenshot(elements: IndexedElement[]): Promise<string>;
  accessibilitySnapshot(): Promise<{ url: string; title: string; ariaSnapshot: string }>;
  /** The pane's REAL viewport (px). Used to de-normalize Moondream point coords
   *  and to report the screenshot frame — must reflect the live pane size, not a
   *  fixed default, or a resized/restored pane clicks the wrong spot. */
  viewport(): Promise<{ width: number; height: number }>;

  // --- Ref-based parity surface (vendored Jarvis snapshot model) ---
  /** Compact ref-based a11y snapshot; stamps `data-topics-ref` on the page. */
  snapshot(opts?: { max?: number }): Promise<Snapshot>;
  /** Act on the element carrying `data-topics-ref="ref"` from the latest snapshot. */
  actByRef(ref: number, action: RefAction, payload?: { text?: string; value?: string; key?: string }): Promise<void>;
  /** Read readable text — one element (by ref) or the whole page. */
  getText(opts?: { ref?: number; max?: number }): Promise<{ text: string; truncated: boolean; length: number }>;
  /** Deterministic CSS-selector scrape (0 LLM tokens). */
  extractFields(fields: ExtractFields): Promise<Record<string, unknown>>;
  /** Run JS in the page sandbox (page context only). */
  evalExpression(expression: string): Promise<{ result: unknown }>;
  /** Best-effort settle: wait (bounded) for the page to go network-idle after a
   *  mutating action, so the post-action snapshot reflects the RESULT (a nav or
   *  async re-render) rather than the pre-effect DOM. Resolves immediately when
   *  already idle, so it only costs time when something is actually in flight. */
  settle?(opts?: { timeout?: number }): Promise<void>;

  // --- Login-state sharing (Jarvis-interop via Playwright storageState) ---
  /** Export the live context's cookies + visited-origin localStorage. */
  exportStorageState(): Promise<StorageState>;
  /** Inject a saved storageState (cookies + localStorage) into the live pane. */
  importStorageState(state: StorageState): Promise<{ cookies: number; origins: number }>;
}

/** Adapter wrapping BrowserService (Phase 30 path). */
export function playwrightOps(service: BrowserService, contextId: string): BrowserOps {
  const page = async (): Promise<Page> => (await service.getOrCreate(contextId)).page;
  return {
    navigate: (url) => service.navigate(contextId, url),
    screenshot: (opts) => service.screenshot(contextId, opts),
    dispatchInput: (type, payload) => service.dispatchInput(contextId, type, payload),
    extractIndexedElements: (opts) => service.extractIndexedElements(contextId, opts),
    captureAnnotatedScreenshot: (els) => service.captureAnnotatedScreenshot(contextId, els),
    accessibilitySnapshot: () => service.accessibilitySnapshot(contextId),
    viewport: async () => {
      // Read the REAL pane size: the configured Playwright viewport if set,
      // else the live layout (innerWidth/Height). A fixed default would mis-scale
      // Moondream point coords on any resized/restored pane → off-target clicks.
      const p = await page();
      const vs = p.viewportSize();
      if (vs && vs.width > 0 && vs.height > 0) return vs;
      try {
        const r = await p.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        if (r && r.width > 0 && r.height > 0) return r;
      } catch { /* page gone — fall through to default */ }
      return { width: 1280, height: 720 };
    },
    // Ref-based parity surface — page-portable helpers run on the server page.
    snapshot: async (opts) => snapshotPage(await page(), opts),
    actByRef: async (ref, action, payload) => actByRefOnPage(await page(), ref, action, payload),
    getText: async (opts) => getTextOnPage(await page(), opts?.ref, opts?.max),
    extractFields: async (fields) => extractFieldsOnPage(await page(), fields),
    evalExpression: async (expression) => evalOnPage(await page(), expression),
    settle: async ({ timeout = 800 } = {}) => {
      const p = await page();
      await p.waitForLoadState('networkidle', { timeout }).catch(() => { /* still busy — bounded */ });
    },
    exportStorageState: async () => exportStateFromContext((await service.getOrCreate(contextId)).context),
    importStorageState: async (state) => applyStateToPage(await page(), state),
  };
}

