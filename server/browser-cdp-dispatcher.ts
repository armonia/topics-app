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
import type { Page } from 'playwright-core';
import { RawCdpPage, type ConsoleEntry } from './browser-cdp-raw';
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
  /** Recent captured page console entries for a contextId (browser_console tool). */
  getConsole(contextId: string, opts?: { level?: "all" | "errors" | "warnings"; limit?: number }): Promise<ConsoleEntry[]>;
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
  // cdpTargetId -> live RawCdpPage. Keyed by the stable targetId (not contextId,
  // so a re-registered target for the same contextId still resolves), with a
  // per-page self-clean when its WebSocket closes (view destroyed / navigated away).
  // RawCdpPage talks CDP directly over the native global WebSocket — playwright's
  // connectOverCDP hangs under Bun (the server's runtime), so we cannot use it.
  const pageCache = new Map<string, RawCdpPage>();

  return {
    registerTarget(contextId, cdpTargetId) {
      if (!cdpTargetId) {
        throw new Error('registerTarget: cdpTargetId is required');
      }
      const unchanged = targetMap.get(contextId) === cdpTargetId;
      targetMap.set(contextId, cdpTargetId);
      nativeBound.add(contextId);
      // The renderer re-registers on a heartbeat (every ~15s per pane) to self-
      // heal the map after a server restart or a transient stale-delete. Skip the
      // disk write when nothing changed so the heartbeat doesn't thrash the file.
      if (!unchanged) saveTargetMap(targetMap);
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
      // Fast path: a still-open page already connected for this targetId.
      const cached = pageCache.get(targetId);
      if (cached && !cached.isClosed()) return cached as unknown as Page;
      if (cached) pageCache.delete(targetId);

      let page: RawCdpPage;
      try {
        page = await RawCdpPage.connect(targetId);
      } catch (err) {
        // Stale mapping (Electron restarted / view destroyed → targetId is gone).
        // Drop the persisted entry so we stop returning a dead target; the renderer
        // re-registers a fresh targetId when the pane next mounts. nativeBound is
        // intentionally KEPT so resolveOps reports "not ready / reopen" (honest)
        // rather than silently using a Playwright phantom.
        targetMap.delete(contextId);
        saveTargetMap(targetMap);
        throw new Error(
          `ElectronCdpDispatcher.getPage: cdpTargetId=${targetId} no longer resolves ` +
          `(${err instanceof Error ? err.message : String(err)}). Re-open the browser pane so it re-registers.`
        );
      }
      pageCache.set(targetId, page);
      return page as unknown as Page;
    },
    async getConsole(contextId, opts) {
      const page = await this.getPage(contextId);
      return (page as unknown as RawCdpPage).getConsole(opts);
    },
    async close() {
      for (const page of pageCache.values()) { try { page.close(); } catch { /* ignore */ } }
      targetMap.clear();
      nativeBound.clear();
      pageCache.clear();
    },
  };
}
