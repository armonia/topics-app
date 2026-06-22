/**
 * Phase 30.1 BROWSER-CHAT-06 — Unified browser operations surface.
 *
 * Both BrowserService (Playwright server-launched) and ElectronCdpDispatcher
 * (Playwright connectOverCDP to Electron host) implement this interface
 * so the 6 tool handlers can target ONE shape regardless of runtime.
 *
 * `broadcastAgentActive` is excluded — it's a service-level concern (the
 * single registry) and stays a separate dep on the handler factory.
 */
import type { Page } from 'playwright-core';
import type { BrowserService } from './browser-service';
import type { ElectronCdpDispatcher } from './browser-cdp-dispatcher';
import type { IndexedElement } from './browser-tools';
import {
  extractIndexedElementsOnPage,
  captureAnnotatedScreenshotOnPage,
} from './browser-dom-walker';
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
  viewport(): { width: number; height: number };

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
    viewport: () => {
      // BrowserService doesn't expose a sync viewport — wrap getOrCreate.
      // Callers use this only for screenshot return shape; default to 1280x720
      // and let the actual call upgrade if needed. The handler does its own
      // viewport read via service.getOrCreate, so this is a safe default.
      return { width: 1280, height: 720 };
    },
    // Ref-based parity surface — page-portable helpers run on the server page.
    snapshot: async (opts) => snapshotPage(await page(), opts),
    actByRef: async (ref, action, payload) => actByRefOnPage(await page(), ref, action, payload),
    getText: async (opts) => getTextOnPage(await page(), opts?.ref, opts?.max),
    extractFields: async (fields) => extractFieldsOnPage(await page(), fields),
    evalExpression: async (expression) => evalOnPage(await page(), expression),
    exportStorageState: async () => exportStateFromContext((await service.getOrCreate(contextId)).context),
    importStorageState: async (state) => applyStateToPage(await page(), state),
  };
}

/**
 * Adapter wrapping ElectronCdpDispatcher (Phase 30.1 path). Mirrors
 * Playwright API on the resolved Page. The action set matches BrowserService
 * but uses page.click/keyboard/wheel directly (no CDP raw screencast since
 * Electron native rendering doesn't need server-side frame stream).
 *
 * extractIndexedElements + captureAnnotatedScreenshot are deferred-and-thrown
 * for now: they require helpers from BrowserService (DOM walker injected via
 * page.evaluate). To avoid duplicating ~150 lines of helper code, MVP
 * delegates these two ops to BrowserService when in Electron mode (see
 * browser-tools-handler.ts Task 4.2 for the routing pattern). This keeps
 * the dispatcher minimal: navigate/screenshot/dispatchInput are the
 * latency-sensitive ops (CDP path is much faster than streaming Playwright
 * server). Observe/extract are agent-side and tolerate web fallback even
 * in Electron mode.
 */
export function cdpOps(
  dispatcher: ElectronCdpDispatcher,
  contextId: string,
  // Retained for signature compatibility; the CDP path no longer delegates
  // observe/extract to the separate Playwright service (that walked the wrong
  // page). Kept as a param so callers don't change.
  _fallbackService: BrowserService,
): BrowserOps {
  return {
    async navigate(url) {
      const page = await dispatcher.getPage(contextId);
      // Idempotent: if the live view is ALREADY at this URL, don't re-navigate.
      // A repeated open_browser_pane (agents often re-open the pane each turn to
      // "make sure it's there") would otherwise reload the page every call —
      // resetting SPA route/in-page state and making it look like the pane keeps
      // restarting / dropping back to login. An explicit nav to a DIFFERENT URL
      // still navigates. (Use the browser reload action for an intentional reload.)
      const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
      if (norm(page.url()) === norm(url)) {
        return { url: page.url(), title: await page.title() };
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { url: page.url(), title: await page.title() };
    },
    async screenshot(opts) {
      const page = await dispatcher.getPage(contextId);
      return await page.screenshot({
        type: opts.format ?? 'jpeg',
        quality: opts.format === 'png' ? undefined : (opts.quality ?? 70),
        fullPage: opts.fullPage ?? false,
      });
    },
    async dispatchInput(type, payload) {
      const page = await dispatcher.getPage(contextId);
      if (type === 'click') {
        await page.mouse.click(payload.x ?? 0, payload.y ?? 0);
      } else if (type === 'type') {
        await page.keyboard.type(payload.text ?? '');
      } else if (type === 'scroll') {
        await page.mouse.wheel(payload.deltaX ?? 0, payload.deltaY ?? 0);
      } else if (type === 'mousemove') {
        await page.mouse.move(payload.x ?? 0, payload.y ?? 0);
      } else if (type === 'keypress') {
        await page.keyboard.press(payload.key ?? '');
      }
    },
    // Observe/extract now run on the REAL WebContentsView (the CDP-resolved
    // page), via the shared page-portable walker. This is the fix for the
    // former BROWSER-CHAT-06 limitation: observe and act target the same DOM,
    // so element bboxes from observe are the exact coordinates act clicks.
    extractIndexedElements: async (opts) => {
      const page = await dispatcher.getPage(contextId);
      return extractIndexedElementsOnPage(page, opts.maxElements);
    },
    captureAnnotatedScreenshot: async (elements) => {
      const page = await dispatcher.getPage(contextId);
      return captureAnnotatedScreenshotOnPage(page, elements);
    },
    accessibilitySnapshot: async () => {
      const page = await dispatcher.getPage(contextId);
      return {
        url: page.url(),
        title: await page.title(),
        ariaSnapshot: await page.locator('body').ariaSnapshot().catch(() => ''),
      };
    },
    viewport: () => ({ width: 1280, height: 720 }), // Electron uses native size; renderer-bound
    // Ref-based parity surface — same helpers, run on the REAL WebContentsView.
    snapshot: async (opts) => snapshotPage(await dispatcher.getPage(contextId), opts),
    actByRef: async (ref, action, payload) =>
      actByRefOnPage(await dispatcher.getPage(contextId), ref, action, payload),
    getText: async (opts) => getTextOnPage(await dispatcher.getPage(contextId), opts?.ref, opts?.max),
    extractFields: async (fields) => extractFieldsOnPage(await dispatcher.getPage(contextId), fields),
    evalExpression: async (expression) => evalOnPage(await dispatcher.getPage(contextId), expression),
    exportStorageState: async () => exportStateFromContext((await dispatcher.getPage(contextId)).context()),
    importStorageState: async (state) => applyStateToPage(await dispatcher.getPage(contextId), state),
  };
}
