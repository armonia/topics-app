/**
 * The browser that photographs a card's preview: Playwright WebKit, never Chromium.
 *
 * WHY A BROWSER OF ITS OWN. Until 04/10 the preview screenshot borrowed the
 * remote-browser service (`server/browser-service.ts`), i.e. `pw.chromium.launch`
 * on the production server. That path runs on EVERY delivery with a URL, without
 * anyone asking, and the workstation rule since 25/09 is WebKit by default on the
 * Mac, Chromium only with an explicit owner's ok (`nochrome`). The remote browser
 * of the panes is a separate decision (it needs CDP for the screencast and is
 * lighter on Chromium, 82 MB against 140 per pane, commit e4c66bb81), so this
 * module takes ONLY the preview off it and leaves the panes where they are.
 *
 * The weight argument does not apply here: a preview is one context for a few
 * seconds, then the process is closed after `idleMs`. At rest it holds zero
 * processes, like the remote browser's idle reaper.
 *
 * Kanban spec: KANBAN-95.
 */
import type { Browser, BrowserContext } from "playwright-core";

type PlaywrightModule = typeof import("playwright-core");

export interface PreviewBrowserOptions {
  /** How Playwright is reached. Injected by tests to see which engine is launched. */
  loadPlaywright?: () => Promise<PlaywrightModule>;
  /** Close the WebKit process this long after the last capture ends. */
  idleMs?: number;
  /** Wait after `domcontentloaded` so the first paint settles. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (...args: unknown[]) => void;
}

export interface PreviewBrowser {
  /** Viewport PNG of `url` at `width`×760 into `outPath`. Best effort → boolean. */
  screenshot(url: string, outPath: string, opts: { width: number }): Promise<boolean>;
  /** True when the page is the Topics shell with no topic open ("Welcome to Topics"). */
  emptyAppShell(url: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Height of the capture: 1440×760 = 0.528, inside the card's 0.70 crop ratio. */
const PREVIEW_HEIGHT = 760;
/** The literal string PanelGrid renders when no topic is selected. */
const EMPTY_SHELL_TEXT = "Welcome to Topics";

export function createPreviewBrowser(opts: PreviewBrowserOptions = {}): PreviewBrowser {
  const loadPlaywright = opts.loadPlaywright ?? (() => import("playwright-core"));
  const idleMs = opts.idleMs ?? 60_000;
  const settleMs = opts.settleMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((...args: unknown[]) => console.error(...args));

  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  async function launch(): Promise<Browser> {
    const pw = await loadPlaywright();
    const b = await pw.webkit.launch({
      headless: true,
      // Same reason as the remote browser (browser-service.ts): Playwright's own
      // signal listeners, removed on browser exit, uninstall Bun's native handler
      // and turn the server's next SIGTERM into an ungraceful kill.
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
    });
    b.on("disconnected", () => { if (browser === b) browser = null; });
    browser = b;
    return b;
  }

  async function ensureBrowser(): Promise<Browser> {
    if (browser?.isConnected()) return browser;
    // Single flight: the screenshot and the empty-shell check of one delivery,
    // or two deliveries at once, must share ONE WebKit.
    if (!launching) launching = launch().finally(() => { launching = null; });
    return launching;
  }

  function scheduleIdleClose(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight > 0 || !browser) return;
      const b = browser;
      browser = null;
      b.close().catch(() => {});
    }, idleMs);
    // A pending idle close must not keep a test runner or a shutting-down server alive.
    (idleTimer as { unref?: () => void }).unref?.();
  }

  /** Open a throwaway context on `url`, hand its page to `capture`, always tear down. */
  async function withPage<T>(url: string, width: number, capture: (page: import("playwright-core").Page) => Promise<T>): Promise<T | null> {
    let scheme = "";
    try { scheme = new URL(url).protocol; } catch { return null; }
    if (scheme !== "http:" && scheme !== "https:") return null;
    inFlight++;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    let context: BrowserContext | null = null;
    try {
      const b = await ensureBrowser();
      context = await b.newContext({ viewport: { width, height: PREVIEW_HEIGHT } });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(settleMs);
      return await capture(page);
    } finally {
      if (context) await context.close().catch(() => {});
      inFlight--;
      if (inFlight === 0) scheduleIdleClose();
    }
  }

  return {
    async screenshot(url, outPath, { width }) {
      try {
        const done = await withPage(url, width, async (page) => {
          await page.screenshot({ path: outPath, type: "png", fullPage: false });
          return true;
        });
        return done === true;
      } catch (err) {
        log("[preview] screenshot", err);
        return false;
      }
    },

    async emptyAppShell(url) {
      try {
        const text = await withPage(url, 1440, (page) =>
          page.evaluate(() => (document.body ? document.body.innerText : "")),
        );
        return typeof text === "string" && text.includes(EMPTY_SHELL_TEXT);
      } catch {
        return false;
      }
    },

    async close() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const b = browser ?? (launching ? await launching.catch(() => null) : null);
      browser = null;
      if (b) await b.close().catch(() => {});
    },
  };
}
