/**
 * Last-resort Chromium: when no Playwright browser and no CHROMIUM_PATH exist,
 * the service launches the Chrome/Edge discovered on the machine.
 * The Playwright launcher is replaced by a spy, so no browser starts.
 *
 * @covers BROWSER-NODE-DEPS-01
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createBrowserService } from "./browser-service";

describe("browser service: installed Chromium fallback", () => {
  const original = { executablePath: chromium.executablePath, launch: chromium.launch };
  const env = { CHROMIUM_PATH: process.env.CHROMIUM_PATH, HOME: process.env.HOME };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bs-home-"));
    delete process.env.CHROMIUM_PATH;
    process.env.HOME = home;
  });

  afterEach(() => {
    chromium.executablePath = original.executablePath;
    chromium.launch = original.launch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("launches the discovered executable when Playwright has no Chromium", async () => {
    const launched: Array<string | undefined> = [];
    chromium.executablePath = () => "";
    chromium.launch = (async (options?: { executablePath?: string }) => {
      launched.push(options?.executablePath);
      return { isConnected: () => true, on: () => {}, close: async () => {}, contexts: () => [] };
    }) as never;

    const service = await createBrowserService({
      discoverInstalledChromium: () => [{ id: "chrome", name: "Chrome", executablePath: "/fake/installed/chrome" }],
    });
    try {
      await service.launch();
      expect(launched).toEqual(["/fake/installed/chrome"]);
    } finally {
      await service.close();
    }
  });
});
