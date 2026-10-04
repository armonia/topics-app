/**
 * Back/forward flags of the streaming pane, as the REAL BrowserService wires
 * them: `framenavigated` and `load` of a page, the CDP history read, and the
 * `nav` messages that reach the pane. The page and the CDP session are fakes
 * the test drives (same injection as browser-service-engine.test.ts), so the
 * history Chromium would report is set by hand.
 * @covers BROWSER-STREAM-HISTORY-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { createBrowserService } from "./browser-service";

type NavMessage = { type: "nav"; url: string; phase: string; canGoBack?: boolean; canGoForward?: boolean };

/** A Chromium tab whose session history and url the test sets. */
async function streamingTab() {
  const world = { entries: ["https://a.test/"], index: 0, url: "https://a.test/" };
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const mainFrame = {};
  const page = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => { (handlers[event] ??= []).push(handler); return page; },
    url: () => world.url,
    title: async () => "T",
    isClosed: () => false,
    close: async () => {},
    mainFrame: () => mainFrame,
  };
  const session = {
    send: async (method: string) => method === "Page.getNavigationHistory"
      ? { currentIndex: world.index, entries: world.entries.map((url) => ({ url })) }
      : { targetInfo: { targetId: "t" } },
    detach: async () => {},
  };
  const context = { newPage: async () => page, newCDPSession: async () => session, close: async () => {} };
  const browser = { contexts: () => [context], newContext: async () => context, close: async () => {}, isConnected: () => true };
  const sent: NavMessage[] = [];
  const svc = await createBrowserService({
    connectOverCDP: async () => browser as unknown as Browser,
    broadcastToBrowserWs: (_id: string, msg: { type: string }) => { if (msg.type === "nav") sent.push(msg as NavMessage); },
  });
  await svc.createContext("ctx", { engine: "chromium", cdpEndpoint: "ws://fake" });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const emit = async (event: string, ...args: unknown[]) => {
    for (const handler of handlers[event] ?? []) await handler(...args);
    await settle();
  };
  /** A cross-document navigation as Chromium runs it: commit, then load. */
  const navigate = async (url: string, shownUrl = url) => {
    world.entries = [...world.entries.slice(0, world.index + 1), url];
    world.index = world.entries.length - 1;
    world.url = shownUrl;
    await emit("framenavigated", mainFrame);
    await emit("load");
  };
  return { world, sent, svc, emit, navigate, mainFrame };
}

let dir: string;
let prevDataDir: string | undefined;
beforeEach(() => {
  // The load handler persists the last real url per context: keep it out of data/.
  dir = mkdtempSync(join(tmpdir(), "nav-history-wiring-"));
  prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(dir, "data");
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("BrowserService nav history wiring", () => {
  it("a failed navigation tells the pane back is lit and the pruned forward is not, without its url", async () => {
    const tab = await streamingTab();
    try {
      // On A with a forward entry (#two), as after a pushState and a back.
      tab.world.entries = ["https://a.test/", "https://a.test/#two"];
      tab.world.index = 0;
      await tab.emit("load");
      expect(tab.sent.at(-1)).toMatchObject({ phase: "response", url: "https://a.test/", canGoBack: false, canGoForward: true });
      tab.sent.length = 0;

      // A domain that does not resolve: Chromium commits its error page as a
      // new entry, pruning #two, and page.url() is its internal url.
      await tab.navigate("https://nope.invalid/", "chrome-error://chromewebdata/");
      expect(tab.sent).toEqual([{ type: "nav", phase: "history", url: "", canGoBack: true, canGoForward: false }]);
      expect(tab.svc.getUrl("ctx")).toMatchObject({ canGoBack: true, canGoForward: false });
    } finally {
      await tab.svc.close();
    }
  });

  it("about:blank typed in the bar moves the arrows, never the pane url", async () => {
    const tab = await streamingTab();
    try {
      await tab.emit("load");
      tab.sent.length = 0;
      await tab.navigate("about:blank");
      expect(tab.sent).toEqual([{ type: "nav", phase: "history", url: "", canGoBack: true, canGoForward: false }]);
    } finally {
      await tab.svc.close();
    }
  });
});
