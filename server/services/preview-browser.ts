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
 * Kanban spec: KANBAN-119.
 */
import type { Browser, BrowserContext } from "playwright-core";
import { loadPlaywrightCore, PLAYWRIGHT_CORE_VERSION } from "../lib/playwright-loader";

type PlaywrightModule = typeof import("playwright-core");

export interface PreviewBrowserOptions {
  /** How Playwright is reached. Injected by tests to see which engine is launched. */
  loadPlaywright?: () => Promise<PlaywrightModule>;
  /** Downloads the WebKit binary when the machine has none. Resolves to an exit code. */
  installEngine?: () => Promise<number>;
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
  /** Why the last capture produced nothing, in one line, or null. Goes on the card. */
  lastFailure(): string | null;
  close(): Promise<void>;
}

/**
 * The launch failure of a machine that HAS Playwright and not its browser.
 * A cloud node created before the provisioning downloaded WebKit answers this,
 * and until then the capture failed silently: the card reached review with no
 * photo, and a board that asks for one parked it in the backlog for ever
 * (measured on two cards, 27/11).
 */
const ENGINE_MISSING = /Executable doesn't exist|playwright install/i;

/**
 * Downloads WebKit into this user's cache, pinned to the version the server
 * loads. The OS libraries need root (`install-deps`, done once by the node
 * provisioning): when they are the missing part this fails too, and then the
 * reason is what reaches the card.
 */
async function defaultInstallEngine(): Promise<number> {
  try {
    const proc = Bun.spawn(["npx", "-y", `playwright@${PLAYWRIGHT_CORE_VERSION}`, "install", "webkit"], { // runtime-dep-ok: bootstrap of the preview's own browser
      stdout: "ignore", stderr: "ignore",
      timeout: ENGINE_INSTALL_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    return await proc.exited;
  } catch {
    return 127; // no npx on this machine
  }
}

/** Deadline of the WebKit download; the process is killed when it passes. */
const ENGINE_INSTALL_TIMEOUT_MS = 300_000;

/** Height of the capture: 1440×760 = 0.528, inside the card's 0.70 crop ratio. */
const PREVIEW_HEIGHT = 760;
/** The literal string PanelGrid renders when no topic is selected. */
const EMPTY_SHELL_TEXT = "Welcome to Topics";

export function createPreviewBrowser(opts: PreviewBrowserOptions = {}): PreviewBrowser {
  const loadPlaywright = opts.loadPlaywright ?? loadPlaywrightCore;
  const idleMs = opts.idleMs ?? 60_000;
  const settleMs = opts.settleMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((...args: unknown[]) => console.error(...args));

  const installEngine = opts.installEngine ?? defaultInstallEngine;

  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let engineInstalled = false;
  let lastFailure: string | null = null;

  async function launchWebkit(pw: PlaywrightModule): Promise<Browser> {
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

  async function launch(): Promise<Browser> {
    const pw = await loadPlaywright();
    try {
      return await launchWebkit(pw);
    } catch (err) {
      // THE MACHINE HAS NO BROWSER: download it once instead of failing for
      // ever. The node provisioning does it at creation time, so this branch is
      // for the machines that already existed when it was added.
      if (!ENGINE_MISSING.test(String((err as Error)?.message ?? err)) || engineInstalled) throw err;
      engineInstalled = true;
      log("[preview] no capture browser on this machine: downloading WebKit once");
      const code = await installEngine();
      if (code !== 0) throw new Error(`the capture browser (WebKit) is missing on this machine and downloading it failed (exit ${code})`);
      return await launchWebkit(pw);
    }
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
        lastFailure = done === true ? null : "la pagina non si è aperta nel browser dell'anteprima";
        return done === true;
      } catch (err) {
        log("[preview] screenshot", err);
        // ONE LINE, AND IT GOES ON THE CARD. A capture that fails mute leaves a
        // card in review with no photo and nothing to act on.
        lastFailure = String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300);
        return false;
      }
    },

    lastFailure() { return lastFailure; },

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
