import type { Page, BrowserContext, Browser } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { loadStorageState, saveStorageState, debouncedSaver } from "./browser-state-store";
import type { Topic } from "./types";

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
      // Legacy fallback chain (macOS hardcoded). Kept for older dev machines
      // that don't have CHROMIUM_PATH set and have an outdated playwright install.
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

    // Phase 30 BROWSER-CHAT-02 — Task 1 stubs. Replaced by real CDP-driven
    // implementations in Task 2 (same plan). Importing the module never
    // throws; calling these methods before Task 2 ships does throw with a
    // clear "not implemented yet" marker so the WS handler in server.ts
    // can ship typecheck-clean as part of Task 1's commit.
    async startScreencast(_id, _onFrame, _opts) {
      throw new Error("startScreencast: not implemented yet — Task 2");
    },
    async stopScreencast(_id) {
      throw new Error("stopScreencast: not implemented yet — Task 2");
    },
    async dispatchInput(_id, _action, _payload) {
      throw new Error("dispatchInput: not implemented yet — Task 2");
    },
  };

  return service;
}
