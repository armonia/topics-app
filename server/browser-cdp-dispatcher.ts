/**
 * Phase 30.1 BROWSER-CHAT-06 — CDP-backed browser dispatcher.
 *
 * When Electron is the host (isElectronCdpAvailable()), the agent tool
 * handlers route HERE instead of through BrowserService (Playwright
 * server-side launched Chromium).
 *
 * Architecture:
 *   - One Playwright Browser instance per server process, lazy-connected
 *     via chromium.connectOverCDP(http://127.0.0.1:19333) on first use.
 *   - One Page per contextId, resolved via the cdpTargetId stored in the
 *     dispatcher's contextId -> cdpTargetId Map.
 *   - The Map is populated by the renderer (via a server REST endpoint or
 *     by the existing /api/browsers/:id POST flow — see Task 5 for wiring).
 *   - All Playwright APIs we already use in BrowserService work the same
 *     way over CDP (page.goto, page.click, page.screenshot, etc.).
 *
 * The client-side hook useNativeBrowser (Task 5) registers the cdpTargetId
 * via POST /api/browsers/:id/cdp-target after creating the WebContentsView.
 * That registration is the only NEW server endpoint this dispatcher needs.
 */
import { chromium, type Browser as PwBrowser, type Page } from 'playwright-core';
import { getElectronCdpEndpoint } from './electron-cdp-probe';

export interface CdpDispatcherDeps {
  /**
   * Broadcast hook used to surface agent_active=true/false to the client
   * (mirrors BrowserService.broadcastAgentActive). Wired in server.ts to
   * the same browserWsClients registry used by Phase 30.
   */
  broadcastAgentActive(contextId: string, active: boolean): void;
}

export interface ElectronCdpDispatcher {
  /** Register a contextId <-> cdpTargetId mapping (called by REST endpoint). */
  registerTarget(contextId: string, cdpTargetId: string): void;
  /** Look up registered target. Returns null if not registered. */
  getTargetId(contextId: string): string | null;
  /** Forget a mapping (called on view destroy). */
  unregisterTarget(contextId: string): void;
  /** Resolve a Page for a contextId, lazily connecting + finding by targetId. */
  getPage(contextId: string): Promise<Page>;
  /** Cleanup on shutdown. */
  close(): Promise<void>;
}

export function createCdpDispatcher(_deps: CdpDispatcherDeps): ElectronCdpDispatcher {
  const targetMap = new Map<string, string>(); // contextId -> cdpTargetId
  let browser: PwBrowser | null = null;

  async function ensureBrowser(): Promise<PwBrowser> {
    if (browser && browser.isConnected()) return browser;
    const endpoint = getElectronCdpEndpoint();
    browser = await chromium.connectOverCDP(endpoint);
    // If Electron host disappears, drop the cached browser so the next
    // call re-attaches.
    browser.on('disconnected', () => {
      if (browser && !browser.isConnected()) {
        browser = null;
      }
    });
    return browser;
  }

  /**
   * Find the Page whose underlying CDP target matches cdpTargetId.
   *
   * Playwright exposes target() on Page in CDP-attached mode. We iterate
   * all contexts -> all pages and match by target id. Cached lookups not
   * needed: contexts/pages are cheap enumerations and the common case is
   * 1-3 pages total in Electron.
   */
  async function findPageByTargetId(b: PwBrowser, cdpTargetId: string): Promise<Page | null> {
    for (const ctx of b.contexts()) {
      for (const page of ctx.pages()) {
        // Playwright Page has a private _target() in CDP mode; we use the
        // public CDP session to query the targetId.
        try {
          const session = await ctx.newCDPSession(page);
          try {
            const info = (await session.send('Target.getTargetInfo')) as {
              targetInfo?: { targetId?: string };
            };
            if (info?.targetInfo?.targetId === cdpTargetId) {
              return page;
            }
          } finally {
            await session.detach().catch(() => { /* ignore */ });
          }
        } catch {
          // Page may have closed mid-iteration.
          continue;
        }
      }
    }
    return null;
  }

  return {
    registerTarget(contextId, cdpTargetId) {
      if (!cdpTargetId) {
        throw new Error('registerTarget: cdpTargetId is required');
      }
      targetMap.set(contextId, cdpTargetId);
    },
    getTargetId(contextId) {
      return targetMap.get(contextId) ?? null;
    },
    unregisterTarget(contextId) {
      targetMap.delete(contextId);
    },
    async getPage(contextId) {
      const targetId = targetMap.get(contextId);
      if (!targetId) {
        throw new Error(
          `ElectronCdpDispatcher.getPage: no cdpTargetId registered for contextId=${contextId}. ` +
          `Client must POST /api/browsers/:id/cdp-target first.`
        );
      }
      const b = await ensureBrowser();
      const page = await findPageByTargetId(b, targetId);
      if (!page) {
        throw new Error(
          `ElectronCdpDispatcher.getPage: no Playwright page matches cdpTargetId=${targetId}. ` +
          `View may have been destroyed.`
        );
      }
      return page;
    },
    async close() {
      if (browser && browser.isConnected()) {
        await browser.close().catch(() => { /* ignore */ });
      }
      browser = null;
      targetMap.clear();
    },
  };
}
