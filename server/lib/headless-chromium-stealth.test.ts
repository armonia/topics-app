/**
 * @covers ANTIBOT-02
 */
import { describe, expect, test } from "bun:test";
import { HEADLESS_AUTOMATION_ARGS, reducedChromeUserAgent } from "./headless-chromium-stealth";

describe("headless-chromium-stealth", () => {
  test("lo switch che azzera navigator.webdriver c'è", () => {
    expect(HEADLESS_AUTOMATION_ARGS).toContain("--disable-blink-features=AutomationControlled");
  });

  test("UA ridotto: versione maggiore, niente Headless, sistema della piattaforma", () => {
    const mac = reducedChromeUserAgent("156.0.8078.4", "darwin");
    expect(mac).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
    expect(mac).not.toMatch(/Headless/);
    expect(reducedChromeUserAgent("147.0.7727.15", "linux")).toContain("X11; Linux x86_64");
    expect(reducedChromeUserAgent("147.0.7727.15", "win32")).toContain("Windows NT 10.0");
  });

  test("una versione illeggibile non inventa un UA", () => {
    expect(reducedChromeUserAgent("boh", "darwin")).toBeUndefined();
  });
});
