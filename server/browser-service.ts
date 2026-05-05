import type { Page, BrowserContext, Browser } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { loadStorageState, saveStorageState, debouncedSaver } from "./browser-state-store";
import type { Topic } from "./types";
import type { IndexedElement } from "./browser-tools";
import type { BrowserWsMessage } from "./browser-ws-messages";

interface BrowserContextEntry {
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastActivity: number;
  url: string;
  title: string;
  consoleMessages: { level: string; text: string; timestamp: number }[];
  persistCookies?: boolean;
  /** Cleanup hook for autosave timer + cancel for debounced saver. */
  autoSaveCleanup?: () => void;
}

interface BrowserServiceOptions {
  maxContexts?: number;
  cleanupIntervalMs?: number;
  inactivityTimeoutMs?: number;
  defaultViewport?: { width: number; height: number };
  screenshotQuality?: number;
  /** CDP remote debugging port (default: 19222 — matches OpenClaw 'topics' browser profile) */
  cdpPort?: number;
  /** Callback invoked after successful navigate(); used to persist topic.browserState. */
  onNavigate?: (contextId: string, url: string, viewport: { width: number; height: number }) => void;
  /** Override Chromium executable path (highest priority). Falls back to env CHROMIUM_PATH, then chromium.executablePath(), then legacy macOS hardcoded path. */
  chromiumPath?: string;
  /** Phase 30 BROWSER-CHAT-03 — broadcast a message to all WS clients
   *  watching a given contextId. Wired by server.ts via browserWsClients
   *  registry. No-op if absent. */
  broadcastToBrowserWs?: (contextId: string, msg: BrowserWsMessage) => void;
}

const MAX_CONSOLE_MESSAGES = 100;

export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  ref?: number;
}

export interface BrowserService {
  launch(): Promise<void>;
  close(): Promise<void>;
  /** Get the CDP target ID for a context's page (used for OpenClaw browser tool routing) */
  getTargetId(id: string): Promise<string | null>;
  createContext(id: string, opts?: { viewport?: { width: number; height: number }; persistCookies?: boolean }): Promise<void>;
  destroyContext(id: string): Promise<void>;
  getOrCreate(id: string): Promise<BrowserContextEntry>;
  navigate(id: string, url: string): Promise<{ url: string; title: string }>;
  goBack(id: string): Promise<{ url: string; title: string }>;
  goForward(id: string): Promise<{ url: string; title: string }>;
  reload(id: string): Promise<void>;
  click(id: string, x: number, y: number, opts?: { button?: "left" | "right" | "middle"; modifiers?: string[] }): Promise<void>;
  clickSelector(id: string, selector: string, opts?: { button?: "left" | "right" | "middle" }): Promise<void>;
  fillSelector(id: string, selector: string, value: string): Promise<void>;
  type(id: string, text: string): Promise<void>;
  keypress(id: string, key: string): Promise<void>;
  scroll(id: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  hover(id: string, x: number, y: number): Promise<void>;
  screenshot(id: string, opts?: { format?: "jpeg" | "png"; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  accessibilitySnapshot(id: string): Promise<{ url: string; title: string; ariaSnapshot: string }>;
  evaluate(id: string, script: string): Promise<any>;
  getConsoleMessages(id: string): { level: string; text: string; timestamp: number }[];
  getUrl(id: string): { url: string; title: string } | null;
  listContexts(): { id: string; url: string; title: string; createdAt: string; lastActivity: number }[];
  resize(id: string, width: number, height: number): Promise<void>;
  isLaunched(): boolean;
  saveCookies(id: string): Promise<void>;
  loadCookies(id: string): Promise<void>;
  /** Restore BrowserContext for every topic with browserState. Best-effort — never throws. */
  restoreAllContexts(topics: Topic[]): Promise<{ restored: number; failed: number }>;
  /** Phase 30 BROWSER-CHAT-02 — start CDP screencast, fire onFrame for every JPEG frame. Returns once startScreencast resolves. Idempotent (calling twice on same id swaps the onFrame handler in place). */
  startScreencast(
    id: string,
    onFrame: (data: string, metadata: { timestamp: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number }) => void,
    opts?: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number }
  ): Promise<void>;
  /** Phase 30 BROWSER-CHAT-02 — stop CDP screencast for a context. Idempotent. */
  stopScreencast(id: string): Promise<void>;
  /** Phase 30 BROWSER-CHAT-02 — dispatch input action via Playwright page.mouse.* / page.keyboard.* / page.mouse.wheel. */
  dispatchInput(
    id: string,
    action: 'click' | 'type' | 'scroll' | 'mousemove' | 'keypress',
    payload: { x?: number; y?: number; text?: string; key?: string; deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle' }
  ): Promise<void>;
  /** Phase 30 BROWSER-CHAT-03 — broadcast `{ type: 'agent_active', active }` over the
   *  /ws/browser/:contextId bridge. No-op when no broadcast callback was wired. */
  broadcastAgentActive(contextId: string, active: boolean): void;
  /** Phase 30 BROWSER-CHAT-03 — DOM walker that indexes interactive elements
   *  with bounding boxes for the browser_observe tool. Side effect: assigns
   *  data-topics-idx="N" attribute on each indexed element (cleaned by
   *  captureAnnotatedScreenshot's finally-block). Max 50 elements default,
   *  clamped to range 1-100. */
  extractIndexedElements(contextId: string, opts?: { maxElements?: number }): Promise<IndexedElement[]>;
  /** Phase 30 BROWSER-CHAT-03 — overlay-injected JPEG screenshot with bbox
   *  bordering + numbered label badges. Returns base64 string. Cleans up the
   *  overlay container + data-topics-idx attributes in a finally block (best
   *  effort — cleanup errors do not propagate). */
  captureAnnotatedScreenshot(contextId: string, elements: IndexedElement[], opts?: { quality?: number }): Promise<string>;
  /** Phase 30 BROWSER-CHAT-04 — DOM info at a viewport point for the
   *  Cursor-style select-element pattern (Cmd+Shift+E). Returns DOM XPath +
   *  CSS-style selector + bbox + truncated text, or null if no element exists
   *  at the point or the context is gone. */
  resolveElementAtPoint(
    contextId: string,
    point: { x: number; y: number },
  ): Promise<{
    path: string;
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text?: string;
  } | null>;
}

export async function createBrowserService(opts: BrowserServiceOptions = {}): Promise<BrowserService> {
  const {
    maxContexts = 20,
    cleanupIntervalMs = 60_000,
    inactivityTimeoutMs = 30 * 60 * 1000,
    defaultViewport = { width: 1280, height: 720 },
    screenshotQuality = 70,
    cdpPort = 19222,
  } = opts;

  const cookieDir = join(process.env.HOME || "/tmp", ".openclaw", "workspace", "topics-app", ".browser-cookies");
  try { mkdirSync(cookieDir, { recursive: true }); } catch {}

  const contexts = new Map<string, BrowserContextEntry>();
  const targetIds = new Map<string, string>();  // contextId → CDP targetId
  // Phase 30 BROWSER-CHAT-02 — active CDP screencast sessions. Keyed by
  // contextId. Set by startScreencast, deleted by stopScreencast (idempotent).
  // Cleaned up by close() and destroyContext() before the underlying
  // BrowserContext is torn down.
  const screencastSessions = new Map<string, {
    cdpSession: import("playwright-core").CDPSession;
    onFrame: (data: string, metadata: { timestamp: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number }) => void;
  }>();
  let browser: Browser | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async function ensureBrowser(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;
    const pw = await import("playwright-core");

    // Path resolution chain (priority order):
    //   1. opts.chromiumPath (constructor)
    //   2. process.env.CHROMIUM_PATH
    //   3. pw.chromium.executablePath() (Playwright bundled Chromium)
    //   4. legacy macOS hardcoded paths (defense in depth, logged warning)
    let chromiumPath: string | undefined;
    const tried: string[] = [];

    if (opts.chromiumPath) {
      chromiumPath = opts.chromiumPath;
      tried.push(`opts.chromiumPath=${chromiumPath}`);
    }
    if (!chromiumPath && process.env.CHROMIUM_PATH) {
      chromiumPath = process.env.CHROMIUM_PATH;
      tried.push(`env CHROMIUM_PATH=${chromiumPath}`);
    }
    if (!chromiumPath) {
      try {
        const pwPath = pw.chromium.executablePath();
        if (pwPath && existsSync(pwPath)) {
          chromiumPath = pwPath;
          tried.push(`playwright-core executablePath=${chromiumPath}`);
        } else {
          tried.push(`playwright-core executablePath=${pwPath || "(empty)"} (not found on disk)`);
        }
      } catch (err: any) {
        tried.push(`playwright-core executablePath threw: ${err.message}`);
      }
    }
    if (!chromiumPath) {
      // BUGFIX 2026-05-05: playwright-core's bundled `executablePath()` can point
      // to a build revision (e.g. chromium-1208) that isn't actually installed
      // on disk if the user has multiple Playwright versions or upgraded
      // @playwright/test independently. Glob the cache dir for ANY existing
      // chromium-* build (highest revision wins) before falling back to
      // hardcoded paths. Recovers gracefully from version drift without
      // requiring user to reinstall browsers.
      const cacheRoot = `${process.env.HOME}/Library/Caches/ms-playwright`;
      try {
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        const dirs = readdirSync(cacheRoot, { withFileTypes: true })
          .filter(d => d.isDirectory() && /^chromium-\d+$/.test(d.name))
          .map(d => ({ name: d.name, rev: parseInt(d.name.split("-")[1] || "0", 10) }))
          .sort((a, b) => b.rev - a.rev);
        for (const dir of dirs) {
          const candidates = [
            `${cacheRoot}/${dir.name}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            `${cacheRoot}/${dir.name}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
            `${cacheRoot}/${dir.name}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            `${cacheRoot}/${dir.name}/chrome-linux/chrome`,
          ];
          for (const p of candidates) {
            if (existsSync(p)) {
              chromiumPath = p;
              if (dir.name !== "chromium-1208") {
                console.warn(`[BrowserService] Auto-discovered Chromium at ${p}. Playwright bundled path missing — using ${dir.name}. Run \`bun playwright install chromium\` to silence this warning.`);
              }
              tried.push(`auto-discovered=${p}`);
              break;
            }
          }
          if (chromiumPath) break;
        }
      } catch (err: any) {
        tried.push(`auto-discovery threw: ${err.message}`);
      }
    }
    if (!chromiumPath) {
      // Legacy fallback chain (macOS hardcoded). Last-resort defense.
      const playwrightDir = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208`;
      const legacy = [
        `${playwrightDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        `${playwrightDir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
        `${playwrightDir}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        `${playwrightDir}/chrome-linux/chrome`,
      ];
      for (const p of legacy) {
        if (existsSync(p)) {
          chromiumPath = p;
          console.warn(`[BrowserService] Using legacy hardcoded Chromium path: ${p}. Set CHROMIUM_PATH env var to silence this warning.`);
          tried.push(`legacy=${p}`);
          break;
        }
      }
    }
    if (!chromiumPath) {
      throw new Error(`Chromium executable not found. Tried:\n  ${tried.join("\n  ")}`);
    }

    console.log(`[BrowserService] Chromium path: ${chromiumPath}`);
    browser = await pw.chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${cdpPort}`,
      ],
    });
    console.log(`[BrowserService] Chromium launched (CDP port: ${cdpPort})`);
    return browser;
  }

  function touchActivity(entry: BrowserContextEntry) {
    entry.lastActivity = Date.now();
  }

  async function setupPage(entry: BrowserContextEntry, _id: string) {
    const page = entry.page;

    // Console capture
    page.on("console", (msg) => {
      entry.consoleMessages.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (entry.consoleMessages.length > MAX_CONSOLE_MESSAGES) {
        entry.consoleMessages.shift();
      }
    });

    // Track navigation
    page.on("load", async () => {
      entry.url = page.url();
      try { entry.title = await page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
    });
  }

  // Cleanup inactive contexts
  function startCleanup() {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of contexts) {
        if (now - entry.lastActivity > inactivityTimeoutMs) {
          console.log(`[BrowserService] Auto-closing inactive context: ${id} (inactive ${Math.round((now - entry.lastActivity) / 60000)}min)`);
          if (entry.persistCookies) service.saveCookies(id).catch(() => {});
          entry.context.close().catch(() => {});
          contexts.delete(id);
        }
      }
    }, cleanupIntervalMs);
  }

  const service: BrowserService = {
    async launch() {
      await ensureBrowser();
      startCleanup();
      console.log("[BrowserService] Ready");
    },

    async close() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      // Phase 30 BROWSER-CHAT-02 — stop all active screencasts BEFORE
      // closing contexts. Detaches CDP sessions cleanly so the close()
      // call doesn't race with in-flight Page.screencastFrame events.
      for (const id of Array.from(screencastSessions.keys())) {
        await service.stopScreencast(id).catch(() => {});
      }
      for (const [_id, entry] of contexts) {
        entry.autoSaveCleanup?.();
        try { await entry.context.close(); } catch {}
      }
      contexts.clear();
      targetIds.clear();
      if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
      }
      console.log("[BrowserService] Closed");
    },

    async createContext(id, opts) {
      if (contexts.has(id)) return;
      if (contexts.size >= maxContexts) {
        throw new Error(`Max contexts (${maxContexts}) reached`);
      }
      const b = await ensureBrowser();
      const viewport = opts?.viewport || defaultViewport;

      // Load persisted storageState if available (cookies + localStorage).
      // null is fine — newContext accepts undefined storageState.
      const persistedState = await loadStorageState(id);
      const context = await b.newContext({
        viewport,
        ...(persistedState ? { storageState: persistedState } : {}),
      });

      try {
        const page = await context.newPage();

        // Capture explicit targetId via CDP (replaces the legacy DOM title-marker hack).
        try {
          const session = await context.newCDPSession(page);
          const info = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
          if (info?.targetInfo?.targetId) {
            targetIds.set(id, info.targetInfo.targetId);
            console.log(`[BrowserService] Captured targetId for ${id}: ${info.targetInfo.targetId}`);
          }
        } catch (err: any) {
          // Non-fatal: getTargetId() will fall back to /json/list query.
          console.warn(`[BrowserService] Failed to capture targetId for ${id}:`, err.message);
        }

        const entry: BrowserContextEntry = {
          context,
          page,
          createdAt: new Date().toISOString(),
          lastActivity: Date.now(),
          url: "about:blank",
          title: "",
          consoleMessages: [],
          persistCookies: opts?.persistCookies,
        };
        contexts.set(id, entry);
        await setupPage(entry, id);

        // Auto-save storageState every 30s + on context close.
        // CRITICAL: setInterval calls saver.flush() (force-save), NOT
        // saver.trigger() (debounced). A debounced trigger at the same
        // period as the debounce delay would re-arm the timer on every
        // tick and never fire.
        const saver = debouncedSaver(id, async () => context.storageState(), 30_000);
        const intervalHandle = setInterval(() => {
          saver.flush().catch(err => console.warn(`[BrowserService] autosave flush failed for ${id}:`, err.message));
        }, 30_000);
        context.on("close", async () => {
          clearInterval(intervalHandle);
          saver.cancel();
          try { await saver.flush(); } catch {}
        });
        entry.autoSaveCleanup = () => {
          clearInterval(intervalHandle);
          saver.cancel();
        };

        // Legacy cookie file load (kept for backwards compat with phase 27 test).
        if (opts?.persistCookies) {
          await service.loadCookies(id);
        }
        console.log(`[BrowserService] Context created: ${id} (total: ${contexts.size}, persisted=${persistedState ? "yes" : "no"})`);
      } catch (err) {
        // Cleanup on failure: drop targetId entry, close the context.
        targetIds.delete(id);
        await context.close().catch(() => {});
        throw err;
      }
    },

    async destroyContext(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      // Phase 30 BROWSER-CHAT-02 — stop screencast first so no in-flight
      // CDP frames target a context that's about to be torn down.
      await service.stopScreencast(id).catch(() => {});
      entry.autoSaveCleanup?.();
      // Final flush before close (best effort).
      try {
        const finalState = await entry.context.storageState();
        await saveStorageState(id, finalState);
      } catch (err: any) {
        console.warn(`[BrowserService] Final state save failed for ${id}:`, err.message);
      }
      if (entry.persistCookies) await service.saveCookies(id);
      try { await entry.context.close(); } catch {}
      contexts.delete(id);
      targetIds.delete(id);
      console.log(`[BrowserService] Context destroyed: ${id} (remaining: ${contexts.size})`);
    },

    async getOrCreate(id) {
      let entry = contexts.get(id);
      if (!entry) {
        await service.createContext(id);
        entry = contexts.get(id)!;
      }
      touchActivity(entry);
      return entry;
    },

    async navigate(id, url) {
      const entry = await service.getOrCreate(id);
      try {
        await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err: any) {
        console.warn(`[BrowserService] Navigate warning for ${id}:`, err.message);
      }
      entry.url = entry.page.url();
      try { entry.title = await entry.page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      // Persist topic.browserState via callback (best effort).
      if (opts.onNavigate) {
        try {
          const vp = entry.page.viewportSize() || defaultViewport;
          opts.onNavigate(id, entry.url, vp);
        } catch (err: any) {
          console.warn(`[BrowserService] onNavigate callback failed for ${id}:`, err.message);
        }
      }
      return { url: entry.url, title: entry.title };
    },

    async goBack(id) {
      const entry = await service.getOrCreate(id);
      await entry.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      entry.url = entry.page.url();
      try { entry.title = await entry.page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      return { url: entry.url, title: entry.title };
    },

    async goForward(id) {
      const entry = await service.getOrCreate(id);
      await entry.page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      entry.url = entry.page.url();
      try { entry.title = await entry.page.title(); } catch { entry.title = ""; }
      touchActivity(entry);
      return { url: entry.url, title: entry.title };
    },

    async reload(id) {
      const entry = await service.getOrCreate(id);
      await entry.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      touchActivity(entry);
    },

    async click(id, x, y, opts) {
      const entry = await service.getOrCreate(id);
      await entry.page.mouse.click(x, y, { button: opts?.button || "left" });
      touchActivity(entry);
    },

    async type(id, text) {
      const entry = await service.getOrCreate(id);
      await entry.page.keyboard.type(text);
      touchActivity(entry);
    },

    async keypress(id, key) {
      const entry = await service.getOrCreate(id);
      await entry.page.keyboard.press(key);
      touchActivity(entry);
    },

    async scroll(id, x, y, deltaX, deltaY) {
      const entry = await service.getOrCreate(id);
      await entry.page.mouse.move(x, y);
      await entry.page.mouse.wheel(deltaX, deltaY);
      touchActivity(entry);
    },

    async hover(id, x, y) {
      const entry = await service.getOrCreate(id);
      await entry.page.mouse.move(x, y);
      touchActivity(entry);
    },

    async screenshot(id, opts) {
      const entry = await service.getOrCreate(id);
      touchActivity(entry);
      return await entry.page.screenshot({
        type: opts?.format || "jpeg",
        quality: opts?.format === "png" ? undefined : (opts?.quality || screenshotQuality),
        fullPage: opts?.fullPage || false,
      });
    },

    async accessibilitySnapshot(id) {
      const entry = await service.getOrCreate(id);
      touchActivity(entry);
      try {
        const ariaSnapshot = await entry.page.locator("body").ariaSnapshot();
        return { url: entry.url, title: entry.title, ariaSnapshot };
      } catch {
        // Fallback: extract text content
        const text = await entry.page.locator("body").innerText().catch(() => "");
        return { url: entry.url, title: entry.title, ariaSnapshot: text };
      }
    },

    async clickSelector(id, selector, opts) {
      const entry = await service.getOrCreate(id);
      await entry.page.click(selector, { button: opts?.button || "left", timeout: 10_000 });
      touchActivity(entry);
    },

    async fillSelector(id, selector, value) {
      const entry = await service.getOrCreate(id);
      await entry.page.fill(selector, value, { timeout: 10_000 });
      touchActivity(entry);
    },

    async saveCookies(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      try {
        const cookies = await entry.context.cookies();
        const filePath = join(cookieDir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
        writeFileSync(filePath, JSON.stringify(cookies, null, 2));
        console.log(`[BrowserService] Cookies saved for context: ${id} (${cookies.length} cookies)`);
      } catch (err: any) {
        console.warn(`[BrowserService] Failed to save cookies for ${id}:`, err.message);
      }
    },

    async loadCookies(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      try {
        const filePath = join(cookieDir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
        if (!existsSync(filePath)) return;
        const cookies = JSON.parse(readFileSync(filePath, "utf-8"));
        await entry.context.addCookies(cookies);
        console.log(`[BrowserService] Cookies loaded for context: ${id} (${cookies.length} cookies)`);
      } catch (err: any) {
        console.warn(`[BrowserService] Failed to load cookies for ${id}:`, err.message);
      }
    },

    async evaluate(id, script) {
      const entry = await service.getOrCreate(id);
      touchActivity(entry);
      return await entry.page.evaluate(script);
    },

    getConsoleMessages(id) {
      const entry = contexts.get(id);
      return entry?.consoleMessages || [];
    },

    getUrl(id) {
      const entry = contexts.get(id);
      if (!entry) return null;
      return { url: entry.url, title: entry.title };
    },

    listContexts() {
      return Array.from(contexts.entries()).map(([id, e]) => ({
        id,
        url: e.url,
        title: e.title,
        createdAt: e.createdAt,
        lastActivity: e.lastActivity,
      }));
    },

    async resize(id, width, height) {
      const entry = await service.getOrCreate(id);
      await entry.page.setViewportSize({ width, height });
      touchActivity(entry);
    },

    isLaunched() {
      return browser !== null && browser.isConnected();
    },

    async getTargetId(id) {
      // Primary: explicit Map (set during createContext via CDP Target.getTargetInfo).
      const cached = targetIds.get(id);
      if (cached) return cached;

      // Fallback: query CDP /json/list — used for restored contexts that
      // pre-date the Map (e.g. resurrected from disk with no targetId capture).
      const entry = contexts.get(id);
      if (!entry) return null;
      try {
        const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const targets = await resp.json() as any[];
        const pageUrl = entry.page.url();
        if (pageUrl !== "about:blank") {
          const byUrl = targets.find((t: any) => t.url === pageUrl && t.type === "page");
          if (byUrl?.id) {
            targetIds.set(id, byUrl.id);  // backfill cache
            return byUrl.id;
          }
        }
        const pageTitle = await entry.page.title().catch(() => "");
        if (pageTitle) {
          const byTitle = targets.find((t: any) => t.title === pageTitle && t.type === "page");
          if (byTitle?.id) {
            targetIds.set(id, byTitle.id);
            return byTitle.id;
          }
        }
        return null;
      } catch (err) {
        console.warn(`[BrowserService] Failed to get targetId for ${id}:`, err);
        return null;
      }
    },

    async restoreAllContexts(topics) {
      let restored = 0;
      let failed = 0;
      for (const topic of topics) {
        if (!topic.browserState) continue;
        const { contextId, url, viewport } = topic.browserState;
        try {
          // createContext loads storageState internally — DO NOT add
          // a separate loadStorageState() call here, it would double-load.
          await service.createContext(contextId, { viewport });
          await service.navigate(contextId, url);
          restored++;
          console.log(`[BrowserService] Restored context ${contextId} for topic ${topic.id} -> ${url}`);
        } catch (err: any) {
          failed++;
          console.warn(`[BrowserService] Failed to restore context for topic ${topic.id}:`, err.message);
        }
      }
      console.log(`[BrowserService] restoreAllContexts: ${restored} restored, ${failed} failed`);
      return { restored, failed };
    },

    // Phase 30 BROWSER-CHAT-02 — push-driven CDP screencast.
    // Pattern (Browser Use 2025 + Playwright 1.59 release notes):
    //   1. Open a dedicated CDP session per context (not the targetId-capture
    //      session — that one is GC'd in createContext after Target.getTargetInfo).
    //   2. Subscribe to Page.screencastFrame, ACK each frame BEFORE invoking
    //      onFrame so the next frame keeps flowing (CDP holds the next frame
    //      until ACK — built-in flow control).
    //   3. Call Page.startScreencast with format/quality tuned for the
    //      BROWSER-CHAT-02 budget (jpeg q70, everyNthFrame=2 -> 15 FPS floor).
    //
    // CDP doc: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast
    async startScreencast(id, onFrame, opts) {
      // Idempotent: if already streaming, swap the onFrame handler in place
      // (lets a re-attach use the existing CDP session without restart).
      const existing = screencastSessions.get(id);
      if (existing) {
        existing.onFrame = onFrame;
        return;
      }

      const entry = await service.getOrCreate(id);
      const cdpSession = await entry.context.newCDPSession(entry.page);

      cdpSession.on("Page.screencastFrame", async (payload: { data: string; sessionId: number; metadata: { timestamp?: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number } }) => {
        // ACK first to keep frames flowing.
        try {
          await cdpSession.send("Page.screencastFrameAck", { sessionId: payload.sessionId });
        } catch (err: any) {
          // ACK can fail if the session/page closed mid-frame — non-fatal.
          console.warn(`[BrowserService] screencastFrameAck failed for ${id}:`, err.message);
          return;
        }
        try {
          const session = screencastSessions.get(id);
          if (!session) return;  // stopScreencast was called between ACK and onFrame
          session.onFrame(payload.data, {
            timestamp: payload.metadata?.timestamp ?? Date.now(),
            pageScaleFactor: payload.metadata?.pageScaleFactor,
            deviceWidth: payload.metadata?.deviceWidth,
            deviceHeight: payload.metadata?.deviceHeight,
          });
        } catch (err: any) {
          console.warn(`[BrowserService] onFrame handler threw for ${id}:`, err.message);
        }
      });

      // Defaults match BROWSER-CHAT-02 budget:
      //   - format jpeg + quality 70 → ~500kbps - 1.5Mbps (target band)
      //   - everyNthFrame 2 → effective 30 → 15 FPS (Nyquist floor)
      //   - maxWidth/maxHeight clamp to viewport (no upscale)
      const viewport = entry.page.viewportSize() || { width: 1280, height: 720 };
      await cdpSession.send("Page.startScreencast", {
        format: opts?.format ?? "jpeg",
        quality: opts?.quality ?? 70,
        maxWidth: opts?.maxWidth ?? viewport.width,
        maxHeight: opts?.maxHeight ?? viewport.height,
        everyNthFrame: opts?.everyNthFrame ?? 2,
      });

      screencastSessions.set(id, { cdpSession, onFrame });
      console.log(`[BrowserService] Screencast started for ${id} (q=${opts?.quality ?? 70}, everyNthFrame=${opts?.everyNthFrame ?? 2})`);
    },

    async stopScreencast(id) {
      const session = screencastSessions.get(id);
      if (!session) return;  // Idempotent
      try {
        await session.cdpSession.send("Page.stopScreencast");
      } catch (err: any) {
        console.warn(`[BrowserService] Page.stopScreencast failed for ${id}:`, err.message);
      }
      try {
        await session.cdpSession.detach();
      } catch (err: any) {
        // CDP detach can fail if context already closed — non-fatal.
        console.warn(`[BrowserService] CDP detach failed for ${id}:`, err.message);
      }
      screencastSessions.delete(id);
      console.log(`[BrowserService] Screencast stopped for ${id}`);
    },

    async dispatchInput(id, action, payload) {
      const entry = await service.getOrCreate(id);
      // Coordinates are sent as native-CSS px from the client (the client-side
      // mapper handles devicePixelRatio via screencast metadata). The server
      // trusts the input as native-CSS px and forwards directly to Playwright.
      switch (action) {
        case 'click':
          if (payload.x == null || payload.y == null) {
            throw new Error("dispatchInput click: x and y required");
          }
          await entry.page.mouse.click(payload.x, payload.y, { button: payload.button ?? 'left' });
          break;
        case 'type':
          if (!payload.text) throw new Error("dispatchInput type: text required");
          await entry.page.keyboard.type(payload.text);
          break;
        case 'scroll':
          // mouse.move + mouse.wheel mirrors existing service.scroll() semantics.
          await entry.page.mouse.move(payload.x ?? 0, payload.y ?? 0);
          await entry.page.mouse.wheel(payload.deltaX ?? 0, payload.deltaY ?? 0);
          break;
        case 'mousemove':
          if (payload.x == null || payload.y == null) {
            throw new Error("dispatchInput mousemove: x and y required");
          }
          await entry.page.mouse.move(payload.x, payload.y);
          break;
        case 'keypress':
          if (!payload.key) throw new Error("dispatchInput keypress: key required");
          await entry.page.keyboard.press(payload.key);
          break;
        default:
          throw new Error(`dispatchInput: unknown action '${action}'`);
      }
      // getOrCreate already touched activity; the action is a real interaction
      // so the entry's lastActivity stays fresh.
    },

    // Phase 30 BROWSER-CHAT-03 — agent_active broadcast over /ws/browser/:contextId.
    // Server.ts wires opts.broadcastToBrowserWs (no-op when absent).
    broadcastAgentActive(contextId, active) {
      if (!opts.broadcastToBrowserWs) return;
      try {
        opts.broadcastToBrowserWs(contextId, { type: 'agent_active', active });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserService] broadcastAgentActive failed for ${contextId}:`, msg);
      }
    },

    // Phase 30 BROWSER-CHAT-03 — DOM walker indexing interactive elements.
    // Pattern: Browser Use bounding-box index (https://browser-use.com).
    // Selector list mirrors the agent-tool-readable surface of the page:
    // buttons, links, inputs, role-based interactive nodes, [onclick], [tabindex].
    // Side effect: writes data-topics-idx="N" on each element (cleaned by
    // captureAnnotatedScreenshot's finally block).
    async extractIndexedElements(contextId, observeOpts) {
      const maxElements = Math.min(Math.max(observeOpts?.maxElements ?? 50, 1), 100);
      const entry = await service.getOrCreate(contextId);
      const elements = await entry.page.evaluate((max: number) => {
        const selectors = [
          'button',
          '[role="button"]',
          'a[href]',
          'input:not([type="hidden"])',
          'select',
          'textarea',
          '[onclick]',
          '[tabindex]:not([tabindex="-1"])',
          '[role="link"]',
          '[role="menuitem"]',
          '[role="checkbox"]',
          '[role="radio"]',
        ].join(',');

        const seen = new Set<Element>();
        const out: Array<{
          id: number;
          role: string;
          name: string;
          bbox: { x: number; y: number; width: number; height: number };
          text?: string;
          tagName: string;
        }> = [];
        let counter = 0;

        const nodes = document.querySelectorAll(selectors);
        for (const node of Array.from(nodes)) {
          if (seen.has(node)) continue;
          seen.add(node);
          if (out.length >= max) break;

          const rect = node.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          if (rect.right < 0 || rect.left > window.innerWidth) continue;

          counter += 1;
          const id = counter;
          const el = node as HTMLElement;
          el.setAttribute('data-topics-idx', String(id));

          const tagName = (node.tagName || '').toLowerCase();
          const ariaRole = node.getAttribute('role');
          const role = ariaRole && ariaRole.trim() ? ariaRole : tagName;

          const ariaLabel = node.getAttribute('aria-label');
          const titleAttr = node.getAttribute('title');
          const innerText = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const name =
            (ariaLabel && ariaLabel.trim()) ||
            (titleAttr && titleAttr.trim()) ||
            innerText.slice(0, 80) ||
            '';

          out.push({
            id,
            role,
            name,
            bbox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            text: innerText.slice(0, 200),
            tagName,
          });
        }
        return out;
      }, maxElements);

      touchActivity(entry);
      return elements as IndexedElement[];
    },

    // Phase 30 BROWSER-CHAT-03 — annotated screenshot via overlay injection.
    // Pattern: Browser Use server-side overlay (one container div with one
    // absolute-positioned colored box per indexed element + numeric label
    // badge). Color rotation green/yellow/red cycled by `(id-1) % 3`.
    // Cleanup is in finally — overlay container removed, data-topics-idx
    // attributes stripped. Cleanup errors are swallowed (best effort).
    async captureAnnotatedScreenshot(contextId, elements, screenshotOpts) {
      const quality = screenshotOpts?.quality ?? 70;
      const entry = await service.getOrCreate(contextId);
      try {
        await entry.page.evaluate((els: IndexedElement[]) => {
          // Remove any leftover overlay first (idempotent).
          const old = document.getElementById('__topics_observe_overlay');
          if (old) old.remove();

          const colors = ['#16a34a', '#eab308', '#dc2626'];
          const container = document.createElement('div');
          container.id = '__topics_observe_overlay';
          container.style.cssText = [
            'position:absolute',
            'top:0',
            'left:0',
            'width:100%',
            'height:100%',
            'pointer-events:none',
            'z-index:2147483647',
          ].join(';');

          for (const el of els) {
            const color = colors[(el.id - 1) % colors.length];
            const box = document.createElement('div');
            box.style.cssText = [
              'position:absolute',
              `left:${el.bbox.x}px`,
              `top:${el.bbox.y}px`,
              `width:${el.bbox.width}px`,
              `height:${el.bbox.height}px`,
              `border:2px solid ${color}`,
              'box-sizing:border-box',
              'pointer-events:none',
            ].join(';');

            const label = document.createElement('span');
            label.textContent = String(el.id);
            label.style.cssText = [
              'position:absolute',
              'top:-20px',
              'left:0',
              'padding:1px 6px',
              `background:${color}`,
              'color:#ffffff',
              'font-family:system-ui,sans-serif',
              'font-size:12px',
              'font-weight:600',
              'border-radius:2px',
              'white-space:nowrap',
            ].join(';');
            box.appendChild(label);
            container.appendChild(box);
          }
          document.body.appendChild(container);
        }, elements);

        let buf: Buffer;
        try {
          buf = await entry.page.screenshot({ type: 'jpeg', quality, fullPage: false });
        } finally {
          // Cleanup overlay + data-topics-idx attrs. Wrapped in try/catch so
          // a broken page doesn't propagate cleanup errors.
          try {
            await entry.page.evaluate(() => {
              const c = document.getElementById('__topics_observe_overlay');
              if (c) c.remove();
              const indexed = document.querySelectorAll('[data-topics-idx]');
              for (const node of Array.from(indexed)) {
                (node as HTMLElement).removeAttribute('data-topics-idx');
              }
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[BrowserService] captureAnnotatedScreenshot cleanup failed for ${contextId}:`, msg);
          }
        }
        touchActivity(entry);
        return buf.toString('base64');
      } catch (err) {
        // Outer catch: if overlay inject itself failed, attempt cleanup once
        // before rethrowing.
        try {
          await entry.page.evaluate(() => {
            const c = document.getElementById('__topics_observe_overlay');
            if (c) c.remove();
          });
        } catch {}
        throw err;
      }
    },

    // Phase 30 BROWSER-CHAT-04 — DOM info at a point for select-element mode.
    // Returns null when the context is missing or no element resolves at the
    // given coords. Pure read; no DOM mutation. The page evaluate walks the
    // ancestor chain to build an XPath-like path and constructs a short CSS
    // selector (tag + #id + up to 3 classes).
    async resolveElementAtPoint(contextId, point) {
      const entry = contexts.get(contextId);
      if (!entry) return null;
      const page = entry.page;
      try {
        const result = await page.evaluate((p: { x: number; y: number }) => {
          const target = document.elementFromPoint(p.x, p.y);
          if (!target) return null;

          // Build an XPath-like path of [tag][index] segments up to <html>.
          const segments: string[] = [];
          let cur: Element | null = target;
          while (cur && cur !== document.documentElement) {
            const parent = cur.parentElement;
            const siblings = parent
              ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
              : [];
            const idx = parent ? siblings.indexOf(cur) + 1 : 1;
            segments.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
            cur = parent;
          }
          const path = '/html/' + segments.join('/');

          const tag = target.tagName.toLowerCase();
          const idAttr = target.id ? `#${target.id}` : '';
          let classes = '';
          const classAttr = target.getAttribute('class');
          if (classAttr) {
            const parts = classAttr.split(/\s+/).filter(Boolean).slice(0, 3);
            if (parts.length > 0) classes = '.' + parts.join('.');
          }
          const cssPath = `${tag}${idAttr}${classes}`;

          const r = target.getBoundingClientRect();
          const txt = (target.textContent || '').trim();
          const text = txt.length > 0 ? txt.slice(0, 80) : undefined;

          return {
            path,
            cssPath,
            bbox: {
              x: Math.round(r.left),
              y: Math.round(r.top),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            text,
          };
        }, point);
        touchActivity(entry);
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[BrowserService] resolveElementAtPoint failed for ${contextId}:`, msg);
        return null;
      }
    },
  };

  return service;
}
