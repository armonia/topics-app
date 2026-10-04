/**
 * @covers KANBAN-95
 *
 * The card preview is photographed by WebKit, never by Chromium. Two layers:
 * the module launches `pw.webkit` and never `pw.chromium`, and the server wires
 * the preview manager's `screenshot`/`emptyAppShell` to this module and not to
 * the remote browser service (whose Chromium stays for the panes).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPreviewBrowser } from "./preview-browser";

type PlaywrightModule = typeof import("playwright-core");

function fakePlaywright(bodyText = "") {
  const calls = {
    chromiumLaunches: 0,
    webkitLaunches: 0,
    launchOpts: [] as Record<string, unknown>[],
    viewports: [] as { width: number; height: number }[],
    gotos: [] as string[],
    contextsClosed: 0,
    browserClosed: 0,
  };
  let connected = false;
  const page = {
    goto: async (url: string) => { calls.gotos.push(url); },
    screenshot: async (o: { path: string }) => { writeFileSync(o.path, "png-bytes"); },
    evaluate: async () => bodyText,
  };
  const browser = {
    isConnected: () => connected,
    on: () => {},
    newContext: async (o: { viewport: { width: number; height: number } }) => {
      calls.viewports.push(o.viewport);
      return { newPage: async () => page, close: async () => { calls.contextsClosed++; } };
    },
    close: async () => { calls.browserClosed++; connected = false; },
  };
  const pw = {
    chromium: {
      launch: async () => {
        calls.chromiumLaunches++;
        throw new Error("the preview must not launch Chromium");
      },
    },
    webkit: {
      launch: async (o: Record<string, unknown>) => {
        calls.webkitLaunches++;
        calls.launchOpts.push(o);
        connected = true;
        return browser;
      },
    },
  } as unknown as PlaywrightModule;
  return { calls, pw };
}

const noSleep = async () => {};
const quiet = () => {};

describe("preview browser (KANBAN-95)", () => {
  test("the screenshot launches WebKit, never chromium.launch, at width x 760", async () => {
    const { calls, pw } = fakePlaywright();
    const pb = createPreviewBrowser({ loadPlaywright: async () => pw, sleep: noSleep, log: quiet });
    const out = join(mkdtempSync(join(tmpdir(), "preview-browser-")), "shot.png");

    const ok = await pb.screenshot("http://localhost:4100/", out, { width: 1440 });

    expect(ok).toBe(true);
    expect(calls.chromiumLaunches).toBe(0);
    expect(calls.webkitLaunches).toBe(1);
    expect(calls.viewports).toEqual([{ width: 1440, height: 760 }]);
    expect(readFileSync(out, "utf8")).toBe("png-bytes");
    expect(calls.contextsClosed).toBe(1);
    // Playwright's signal listeners must stay off (see browser-service.ts).
    expect(calls.launchOpts[0]).toMatchObject({ headless: true, handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false });
    await pb.close();
  });

  test("the empty-shell check launches WebKit and reads the page text", async () => {
    const { calls, pw } = fakePlaywright("Welcome to Topics\nOpen a topic");
    const pb = createPreviewBrowser({ loadPlaywright: async () => pw, sleep: noSleep, log: quiet });

    expect(await pb.emptyAppShell("http://localhost:4100/")).toBe(true);
    expect(calls.chromiumLaunches).toBe(0);
    expect(calls.webkitLaunches).toBe(1);
    await pb.close();
  });

  test("one delivery's two captures share one WebKit, closed once idle", async () => {
    const { calls, pw } = fakePlaywright();
    const pb = createPreviewBrowser({ loadPlaywright: async () => pw, sleep: noSleep, log: quiet, idleMs: 20 });
    const out = join(mkdtempSync(join(tmpdir(), "preview-browser-")), "shot.png");

    await Promise.all([
      pb.screenshot("http://localhost:4100/", out, { width: 1440 }),
      pb.emptyAppShell("http://localhost:4100/"),
    ]);
    expect(calls.webkitLaunches).toBe(1);
    expect(calls.browserClosed).toBe(0);

    await new Promise((r) => setTimeout(r, 80));
    // Zero processes at rest: the idle close ran.
    expect(calls.browserClosed).toBe(1);
  });

  test("a non-http URL is refused without launching anything", async () => {
    const { calls, pw } = fakePlaywright();
    const pb = createPreviewBrowser({ loadPlaywright: async () => pw, sleep: noSleep, log: quiet });
    const out = join(mkdtempSync(join(tmpdir(), "preview-browser-")), "shot.png");

    expect(await pb.screenshot("file:///etc/passwd", out, { width: 1440 })).toBe(false);
    expect(calls.webkitLaunches + calls.chromiumLaunches).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  test("server.ts wires the preview captures to this module, not to the Chromium browser service", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "server.ts"), "utf8");
    const start = src.indexOf("previewManager = createPreviewManager({");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n});", start));
    const deps = block.slice(block.indexOf("emptyAppShell:"), block.indexOf("currentOutputUrl:"));
    expect(deps).toContain("previewBrowser.emptyAppShell(");
    expect(deps).toContain("previewBrowser.screenshot(");
    expect(block).not.toContain("browserService");
  });
});
