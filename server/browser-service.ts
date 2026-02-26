import type { Page, BrowserContext, Browser } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

interface BrowserContextEntry {
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastActivity: number;
  url: string;
  title: string;
  consoleMessages: { level: string; text: string; timestamp: number }[];
  persistCookies?: boolean;
}

interface BrowserServiceOptions {
  maxContexts?: number;
  cleanupIntervalMs?: number;
  inactivityTimeoutMs?: number;
  defaultViewport?: { width: number; height: number };
  screenshotQuality?: number;
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
  accessibilitySnapshot(id: string): Promise<{ url: string; title: string; tree: AccessibilityNode | null }>;
  evaluate(id: string, script: string): Promise<any>;
  getConsoleMessages(id: string): { level: string; text: string; timestamp: number }[];
  getUrl(id: string): { url: string; title: string } | null;
  listContexts(): { id: string; url: string; title: string; createdAt: string; lastActivity: number }[];
  resize(id: string, width: number, height: number): Promise<void>;
  isLaunched(): boolean;
  saveCookies(id: string): Promise<void>;
  loadCookies(id: string): Promise<void>;
}

export async function createBrowserService(opts: BrowserServiceOptions = {}): Promise<BrowserService> {
  const {
    maxContexts = 20,
    cleanupIntervalMs = 60_000,
    inactivityTimeoutMs = 30 * 60 * 1000,
    defaultViewport = { width: 1280, height: 720 },
    screenshotQuality = 70,
  } = opts;

  const cookieDir = join(process.env.HOME || "/tmp", ".openclaw", "workspace", "topics-app", ".browser-cookies");
  try { mkdirSync(cookieDir, { recursive: true }); } catch {}

  const contexts = new Map<string, BrowserContextEntry>();
  let browser: Browser | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async function ensureBrowser(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;
    const pw = await import("playwright-core");
    const playwrightDir = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208`;
    const possiblePaths = [
      `${playwrightDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${playwrightDir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
      `${playwrightDir}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${playwrightDir}/chrome-linux/chrome`,
    ];
    const chromiumPath = possiblePaths.find(p => existsSync(p));
    if (!chromiumPath) {
      throw new Error(`Chromium executable not found. Searched: ${possiblePaths.join(", ")}`);
    }
    browser = await pw.chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    console.log("[BrowserService] Chromium launched");
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
        try { await entry.context.close(); } catch {}
      }
      contexts.clear();
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
      const context = await b.newContext({ viewport });
      const page = await context.newPage();
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
      // Load persisted cookies if available
      if (opts?.persistCookies) {
        await service.loadCookies(id);
      }
      console.log(`[BrowserService] Context created: ${id} (total: ${contexts.size})`);
    },

    async destroyContext(id) {
      const entry = contexts.get(id);
      if (!entry) return;
      if (entry.persistCookies) await service.saveCookies(id);
      try { await entry.context.close(); } catch {}
      contexts.delete(id);
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
      const tree = await entry.page.accessibility.snapshot() as AccessibilityNode | null;
      return { url: entry.url, title: entry.title, tree };
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
  };

  return service;
}
