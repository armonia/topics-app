/** @covers BROWSER-CHAT-06 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserService } from "./browser-service";
import { handleBrowserVerify } from "./browser-verify";

const env = process.env.TOPICS_HOME;
let tempRoot = "";

afterEach(() => {
  if (env === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = env;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

function setupPage(opts: { reload?: (options: { waitUntil: string }) => Promise<void>; reloadColor?: (waitUntil: string) => string; color?: string } = {}) {
  tempRoot = mkdtempSync(join(tmpdir(), "topics-browser-verify-"));
  process.env.TOPICS_HOME = tempRoot;
  const active: boolean[] = [];
  let currentColor = opts.color ?? "rgb(180, 20, 20)";
  const page = {
    async reload(options: { waitUntil: string }) {
      await (opts.reload?.(options) ?? Promise.resolve());
      currentColor = opts.color ?? opts.reloadColor?.(options.waitUntil) ?? "rgb(0, 128, 0)";
    },
    async goto() { await (opts.reload?.({ waitUntil: "load" }) ?? Promise.resolve()); currentColor = opts.color ?? "rgb(0, 128, 0)"; },
    // The stylesheet of the new page applies only once it has loaded.
    async waitForLoadState(state: string) { if (state === "load") currentColor = opts.color ?? "rgb(0, 128, 0)"; },
    async evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T> {
      const element = {
        textContent: "Nuovo prezzo",
        getClientRects: () => [{}],
      };
      // Put back what was there, deleting what was not: a key left behind as
      // `undefined` still trips the DOM-leak guard of the test preload.
      const g = globalThis as unknown as Record<string, unknown>;
      const saved = (["document", "getComputedStyle"] as const).map((key) => [key, key in g, g[key]] as const);
      Object.assign(g, {
        document: { querySelector: (selector: string) => selector === ".price" ? element : null },
        getComputedStyle: () => ({ display: "block", visibility: "visible", getPropertyValue: (name: string) => name === "color" ? currentColor : "" }),
      });
      try { return fn(arg); }
      finally {
        for (const [key, had, value] of saved) {
          if (had) g[key] = value;
          else delete g[key];
        }
      }
    },
    async screenshot() { return Buffer.from("jpeg-fixture"); },
    viewportSize() { return { width: 1024, height: 768 }; },
    url() { return "http://127.0.0.1:12345/fixture.html"; },
    async title() { return "Verify fixture"; },
  };
  const service = {
    broadcastAgentActive(_id: string, value: boolean) { active.push(value); },
    async getOrCreate() { return { page }; },
    // Like the real one: resolves at domcontentloaded, the old style still applied.
    async navigate(_id: string, url: string) { currentColor = "rgb(180, 20, 20)"; return { url, title: "Verify fixture" }; },
    getConsoleMessages() {
      const at = Date.now();
      return [
        { level: "error", text: "before reload", timestamp: at - 1000 },
        { level: "error", text: "after reload", timestamp: at + 1 },
        { level: "warning", text: "warning", timestamp: at + 1 },
      ];
    },
    getNetworkEntries() {
      const at = Date.now();
      return [
        { startedAt: at - 1000, method: "GET", url: "/old", resourceType: "fetch", status: 500 },
        { startedAt: at + 1, method: "GET", url: "/failed", resourceType: "fetch", failure: "net::ERR_FAILED" },
        { startedAt: at + 1, method: "GET", url: "/bad-status", resourceType: "fetch", status: 503 },
      ];
    },
  } as unknown as BrowserService;
  return { service, active };
}

describe("browser_verify", () => {
  test("waits for external CSS after DOMContentLoaded before checking styles", async () => {
    let waitUntil = "";
    const { service } = setupPage({
      reload: async (options) => { waitUntil = options.waitUntil; },
      reloadColor: (state) => state === "load" ? "rgb(0, 128, 0)" : "rgb(180, 20, 20)",
    });
    const result = await handleBrowserVerify(service, "verify-css-load", {
      checks: [{ selector: ".price", style: { color: "rgb(0, 128, 0)" } }],
    }) as { checks: { selector: string; status: string; value?: { style?: Record<string, string> } }[] };

    expect(waitUntil).toBe("load");
    expect(result.checks).toMatchObject([{ selector: ".price", status: "pass", value: { style: { color: "rgb(0, 128, 0)" } } }]);
  });

  test("with a url, waits for the stylesheets after navigating before checking styles", async () => {
    const { service } = setupPage();
    const result = await handleBrowserVerify(service, "verify-url", {
      url: "http://127.0.0.1:12345/fixture.html",
      checks: [{ selector: ".price", style: { color: "rgb(0, 128, 0)" } }],
    }) as { checks: { status: string; value?: { style?: Record<string, string> } }[] };

    expect(result.checks).toMatchObject([{ status: "pass", value: { style: { color: "rgb(0, 128, 0)" } } }]);
  });

  test("reloads, captures only new console errors, and reports passing and failing checks with values", async () => {
    const { service, active } = setupPage();
    const result = await handleBrowserVerify(service, "verify-test", {
      checks: [
        { selector: ".price", text: "Nuovo", visible: true, style: { color: "rgb(0, 128, 0)" } },
        { selector: ".price", style: { color: "rgb(255, 0, 0)" } },
      ],
    }) as {
      url: string;
      title: string;
      screenshot: { path: string; bytes: number; viewport: { width: number; height: number } };
      consoleErrors: { text: string }[];
      failedRequests: { url: string; failure?: string; status?: number }[];
      checks: { status: string; value: { style?: Record<string, string> } }[];
    };

    expect(active).toEqual([true, false]);
    expect(result.url).toContain("fixture.html");
    expect(result.title).toBe("Verify fixture");
    expect(result.screenshot.bytes).toBeGreaterThan(0);
    expect(result.screenshot.viewport).toEqual({ width: 1024, height: 768 });
    expect(readFileSync(result.screenshot.path).toString()).toBe("jpeg-fixture");
    expect(result.consoleErrors.map((item) => item.text)).toEqual(["after reload"]);
    expect(result.failedRequests.map((item) => item.url)).toEqual(["/failed", "/bad-status"]);
    expect(result.checks.map((item) => item.status)).toEqual(["pass", "fail"]);
    expect(result.checks[1]?.value.style?.color).toBe("rgb(0, 128, 0)");
  });

  test("returns a readable load timeout", async () => {
    const { service } = setupPage({ reload: async () => { throw new Error("Timeout 15000ms exceeded"); } });
    await expect(handleBrowserVerify(service, "verify-timeout", {})).resolves.toMatchObject({
      error: expect.stringContaining("page did not finish loading within 15 s"),
    });
  });
});
