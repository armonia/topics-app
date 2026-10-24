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
 * `Runtime.evaluate` and plays the page: the start script only produces the
 * first snapshot when the recorder was evaluated before it.
 * @covers BROWSER-DOM-RECORDER-01
 * @covers DOMCO-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { createBrowserService } from "./browser-service";
import { getRrwebRecorderSource } from "./lib/rrweb-recorder";

/** The guard that keeps a second evaluation from clobbering a live recorder. */
const GUARD = "if(!(window.rrweb&&window.rrweb.record)){";
const META = { type: 4, data: { href: "https://a.test/", width: 800, height: 600 }, timestamp: 1 };
const FULL = { type: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } }, timestamp: 2 };

/** A Chromium tab whose CDP session records what is evaluated in the page. */
async function recordingTab() {
  const evaluated: string[] = [];
  const world = { recorderLoaded: false };
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
      if (expression.includes(getRrwebRecorderSource())) world.recorderLoaded = true;
      // rrweb emits Meta then FullSnapshot when record() starts, and record()
      // only exists once the recorder text has run in this document.
      if (expression.includes("window.rrweb.record({") && world.recorderLoaded) {
        emitToHost?.(JSON.stringify({ kind: "event", event: META }));
        emitToHost?.(JSON.stringify({ kind: "event", event: FULL }));
      }
      return {};
    },
    detach: async () => {},
  };
  const context = { newPage: async () => page, newCDPSession: async () => session, close: async () => {} };
  const browser = { contexts: () => [context], newContext: async () => context, close: async () => {}, isConnected: () => true };
  const svc = await createBrowserService({ connectOverCDP: async () => browser as unknown as Browser });
  await svc.createContext("ctx", { engine: "chromium", cdpEndpoint: "ws://fake" });
  return { svc, evaluated };
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
  // The timeout is for the red case: without a recorder enableDomMode waits for
  // a snapshot that never comes (about 4 s) before it gives up.
  it("evaluates the recorder inside its guard, then the start script, and returns the snapshot", async () => {
    const tab = await recordingTab();
    try {
      const boot = await tab.svc.enableDomMode("ctx");

      expect(tab.evaluated).toHaveLength(2);
      const [bundle, start] = tab.evaluated;
      // The recorder text, whole, inside the guard block.
      const source = getRrwebRecorderSource();
      const at = bundle.indexOf(source);
      expect(bundle.startsWith(GUARD)).toBe(true);
      expect(at).toBeGreaterThanOrEqual(GUARD.length);
      expect(bundle.slice(GUARD.length, at).trim()).toBe("");
      expect(bundle.slice(at + source.length).trimEnd().endsWith("}")).toBe(true);
      // Then the script that starts recording, never the other way round.
      expect(start).toContain("window.rrweb.record({");
      expect(start).not.toContain(source);

      expect(boot).toEqual([META, FULL]);
    } finally {
      await tab.svc.close();
    }
  }, 15_000);
});
