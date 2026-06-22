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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Persist the contextId -> cdpTargetId map so it survives a SERVER restart.
// cdpTargetIds are stable for the life of the Electron process — a server bounce
// (e.g. launchd) doesn't touch Electron — so the persisted map is still valid when
// the server comes back, WITHOUT waiting for the renderer to re-register. Stale
// entries (e.g. after an Electron restart) self-clean in getPage when the target
// no longer resolves. Lives next to the app's other ~/.topics state.
const CDP_TARGETS_FILE = join(homedir(), '.topics', 'browser-cdp-targets.json');

function loadTargetMap(): Map<string, string> {
  try {
    if (existsSync(CDP_TARGETS_FILE)) {
      const obj = JSON.parse(readFileSync(CDP_TARGETS_FILE, 'utf8')) as Record<string, string>;
      return new Map(Object.entries(obj));
    }
  } catch { /* ignore — start empty */ }
  return new Map();
}

function saveTargetMap(map: Map<string, string>): void {
  try {
    mkdirSync(dirname(CDP_TARGETS_FILE), { recursive: true });
    writeFileSync(CDP_TARGETS_FILE, JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch { /* best-effort persistence */ }
}

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
  /**
   * True once a contextId has registered a native WebContentsView at least once
   * and has not been deliberately closed. Lets resolveOps refuse the invisible
   * Playwright fallback for a context that owns a native pane — instead of
   * silently driving a phantom browser the user never sees, it waits for the
   * target to (re)appear or fails loud. Lifecycle-tied, in-memory only (does NOT
   * persist across server restart — a stale post-restart targetId self-cleans in
   * getPage, and the renderer re-registers on the next pane mount).
   */
  isNativeBound(contextId: string): boolean;
  /** Forget a mapping (called on view destroy). */
  unregisterTarget(contextId: string): void;
  /** Resolve a Page for a contextId, lazily connecting + finding by targetId. */
  getPage(contextId: string): Promise<Page>;
  /** Cleanup on shutdown. */
  close(): Promise<void>;
}

export function createCdpDispatcher(_deps: CdpDispatcherDeps): ElectronCdpDispatcher {
  const targetMap = loadTargetMap(); // contextId -> cdpTargetId (persisted; survives server restart)
  // Contexts that have registered a native WebContentsView this process lifetime
  // and not been deliberately closed. In-memory ONLY: a server restart starts it
  // empty so a stale persisted targetId can't keep a context "native-forever"
  // before the renderer re-registers (the persisted targetMap self-cleans on the
  // first failed getPage anyway).
  const nativeBound = new Set<string>();
  let browser: PwBrowser | null = null;
  // cdpTargetId -> Page resolution cache. findPageByTargetId opens+detaches a
  // CDP session per page per lookup; getPage runs on EVERY observe/act (2 walks
  // per act), so without this the agent pays an O(pages) CDP round-trip storm on
  // the hot path. Keyed by the stable targetId (not contextId, so a re-registered
  // target for the same contextId still resolves), with a per-page self-clean.
  const pageCache = new Map<string, Page>();

  async function ensureBrowser(): Promise<PwBrowser> {
    if (browser && browser.isConnected()) return browser;
    const endpoint = getElectronCdpEndpoint();
    browser = await chromium.connectOverCDP(endpoint);
    // If Electron host disappears, drop the cached browser so the next
    // call re-attaches.
    browser.on('disconnected', () => {
      if (browser && !browser.isConnected()) {
        browser = null;
        pageCache.clear();
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
      nativeBound.add(contextId);
      saveTargetMap(targetMap);
    },
    getTargetId(contextId) {
      return targetMap.get(contextId) ?? null;
    },
    isNativeBound(contextId) {
      return nativeBound.has(contextId);
    },
    unregisterTarget(contextId) {
      nativeBound.delete(contextId);
      if (targetMap.delete(contextId)) saveTargetMap(targetMap);
    },
    async getPage(contextId) {
      const targetId = targetMap.get(contextId);
      if (!targetId) {
        throw new Error(
          `ElectronCdpDispatcher.getPage: no cdpTargetId registered for contextId=${contextId}. ` +
          `Client must POST /api/browsers/:id/cdp-target first.`
        );
      }
      // Fast path: a still-open page already resolved for this targetId.
      const cached = pageCache.get(targetId);
      if (cached && !cached.isClosed()) return cached;
      if (cached) pageCache.delete(targetId);

      const b = await ensureBrowser();
      const page = await findPageByTargetId(b, targetId);
      if (!page) {
        // Stale mapping (e.g. Electron restarted → this targetId no longer exists).
        // Drop it so we don't keep returning a dead target; the renderer re-registers
        // a fresh targetId when the pane next mounts.
        targetMap.delete(contextId);
        saveTargetMap(targetMap);
        throw new Error(
          `ElectronCdpDispatcher.getPage: no Playwright page matches cdpTargetId=${targetId} ` +
          `(stale mapping dropped). Re-open the browser pane so it re-registers.`
        );
      }
      // Memoize and self-invalidate when the page closes, so the walk runs once
      // per pane lifetime instead of once per op.
      pageCache.set(targetId, page);
      page.once('close', () => {
        if (pageCache.get(targetId) === page) pageCache.delete(targetId);
      });
      return page;
    },
    async close() {
      if (browser && browser.isConnected()) {
        await browser.close().catch(() => { /* ignore */ });
      }
      browser = null;
      targetMap.clear();
      nativeBound.clear();
      pageCache.clear();
    },
  };
}
