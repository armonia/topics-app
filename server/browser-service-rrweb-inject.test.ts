/**
 * The rrweb recorder really reaches the page when DOM mode is turned on.
 *
 * The only other test that exercises the injection (browser-dom-cobrowse.test.ts)
 * launches a real Chromium and is skipped unless TOPICS_HEAVY_TESTS=1, which no
 * workflow sets: in CI nobody checked that the recorder text is still wrapped in
 * its idempotence guard, or that the arm chain still evaluates it before the
 * start script. Dropping either one leaves DOM mode without a recorder, and the
 * pane falls back to video with nothing red anywhere.
 *
 * Here the REAL BrowserService runs against a fake Chromium (same injection as
 * browser-service-nav-history.test.ts). The fake CDP session records every
 * `Runtime.evaluate` and plays the page. The recorder bundle RUNS, in a node:vm
 * context whose global object is `window`: Runtime.evaluate runs it the same
 * way, as a classic script at page-global scope, so whether `window.rrweb.record`
 * exists afterwards is decided by the bundle itself, not by a text match. The
 * start script stays emulated (rrweb's record() needs a DOM): it is only
 * compiled, so a syntax error fails the evaluation as it does in Chromium, and
 * it produces the first snapshot only when the recorder already defined
 * `window.rrweb.record`.
 * @covers BROWSER-DOM-RECORDER-01
 * @covers DOMCO-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import type { Browser } from "playwright-core";
import { createBrowserService } from "./browser-service";

const META = { type: 4, data: { href: "https://a.test/", width: 800, height: 600 }, timestamp: 1 };
const FULL = { type: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } }, timestamp: 2 };

/** The page's global object, as the recorder bundle sees it. */
type PageWindow = Record<string, unknown> & { rrweb?: { record?: unknown } };

/** A Chromium tab whose CDP session runs the recorder in a page-like global. */
async function recordingTab(pageGlobals: Record<string, unknown> = {}, opts: { bundleFails?: boolean } = {}) {
  const evaluated: string[] = [];
  const pageWindow: PageWindow = { ...pageGlobals };
  pageWindow.window = pageWindow;
  createContext(pageWindow);
  let emitToHost: ((json: string) => void) | null = null;
  const page = {
    on: () => page,
    url: () => "https://a.test/",
    title: async () => "A",
    isClosed: () => false,
    close: async () => {},
    mainFrame: () => ({}),
    waitForLoadState: async () => {},
    exposeFunction: async (name: string, fn: (json: string) => void) => {
      if (name === "__rrwebEmit") emitToHost = fn;
    },
  };
  const session = {
    send: async (method: string, params?: { expression?: string }) => {
      if (method !== "Runtime.evaluate") return { targetInfo: { targetId: "t" } };
      const expression = params?.expression ?? "";
      evaluated.push(expression);
      if (expression.includes("window.rrweb.record({")) {
        // Compiled, not run: a start script that does not parse fails here as
        // Runtime.evaluate fails, and DOM mode falls back to video. Function and
        // not vm.Script, which under Bun parses only when it runs.
        try {
          new Function(expression);
        } catch (err) {
          return { exceptionDetails: { text: "Uncaught", exception: { description: String(err) } } };
        }
        // The start script: rrweb emits Meta then FullSnapshot when record()
        // starts (or when a live recorder takes a fresh snapshot), and record()
        // exists only if the recorder bundle defined it in this document.
        if (typeof pageWindow.rrweb?.record === "function") {
          emitToHost?.(JSON.stringify({ kind: "event", event: META }));
          emitToHost?.(JSON.stringify({ kind: "event", event: FULL }));
        }
        return {};
      }
      // Anything else is the recorder bundle: it runs for real. An exception
      // comes back in the RESULT, as CDP reports it.
      try {
        if (opts.bundleFails) throw new Error("bundle refused");
        runInContext(expression, pageWindow);
      } catch (err) {
        return { exceptionDetails: { text: "Uncaught", exception: { description: String(err) } } };
      }
      return {};
    },
    detach: async () => {},
  };
  const context = { newPage: async () => page, newCDPSession: async () => session, close: async () => {} };
  const browser = { contexts: () => [context], newContext: async () => context, close: async () => {}, isConnected: () => true };
  const svc = await createBrowserService({ connectOverCDP: async () => browser as unknown as Browser });
  await svc.createContext("ctx", { engine: "chromium", cdpEndpoint: "ws://fake" });
  return { svc, evaluated, pageWindow };
}

let dir: string;
let prevDataDir: string | undefined;
beforeEach(() => {
  // Context creation persists per-context state: keep it out of data/.
  dir = mkdtempSync(join(tmpdir(), "rrweb-inject-"));
  prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(dir, "data");
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("DOM mode injects the rrweb recorder", () => {
  // The timeouts are for the red cases: without a recorder enableDomMode waits
  // for a snapshot that never comes (about 4 s) before it gives up.
  it("the recorder bundle defines window.rrweb.record in the page, before the start script, and the snapshot comes back", async () => {
    const tab = await recordingTab();
    try {
      const boot = await tab.svc.enableDomMode("ctx");

      expect(typeof tab.pageWindow.rrweb?.record).toBe("function");
      // One bundle, then the script that starts recording: the start only
      // finds record() because the bundle ran first.
      expect(tab.evaluated).toHaveLength(2);
      expect(boot).toEqual([META, FULL]);
    } finally {
      await tab.svc.close();
    }
  }, 15_000);

  it("a second enable evaluates the bundle again and leaves the live window.rrweb in place", async () => {
    const tab = await recordingTab();
    try {
      await tab.svc.enableDomMode("ctx");
      const live = tab.pageWindow.rrweb;
      expect(typeof live?.record).toBe("function");

      const again = await tab.svc.enableDomMode("ctx");

      expect(tab.evaluated).toHaveLength(4);
      // Replacing it would hand late joiners a fresh copy whose "recording
      // started" state is false: the guard must keep the same object.
      expect(tab.pageWindow.rrweb).toBe(live);
      expect(again).toEqual([META, FULL]);
    } finally {
      await tab.svc.close();
    }
  }, 15_000);

  // The start script follows the bundle in one chain: when the page refuses
  // the bundle (a navigation in the middle, an evaluate that fails) the start
  // is not sent, and the failure ends inside the chain instead of escaping as
  // an unhandled rejection, which nothing on the server catches.
  it("a bundle the page refuses ends the chain: the start script is not sent", async () => {
    const tab = await recordingTab({}, { bundleFails: true });
    try {
      await tab.svc.enableDomMode("ctx");

      expect(tab.evaluated).toHaveLength(1);
      expect(tab.pageWindow.rrweb).toBeUndefined();
    } finally {
      await tab.svc.close();
    }
  }, 15_000);

  // An element with id="rrweb" is a named property of window, and a page can
  // own a global of that name: the guard asks for the recorder, not the name.
  it("a page global named rrweb that is not the recorder does not keep the bundle out", async () => {
    const tab = await recordingTab({ rrweb: { nodeName: "DIV" } });
    try {
      const boot = await tab.svc.enableDomMode("ctx");

      expect(typeof tab.pageWindow.rrweb?.record).toBe("function");
      expect(boot).toEqual([META, FULL]);
    } finally {
      await tab.svc.close();
    }
  }, 15_000);
});
