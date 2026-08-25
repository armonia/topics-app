/**
 * @covers CHROMECK-01
 */
import { test, expect } from "bun:test";
import { COOKIE_BROWSERS, isCookieBrowser, listChromeCookieHosts } from "./chrome-cookies";

/**
 * The browser id reaches BOTH a filesystem path and a `security find-generic-password`
 * argv, so it must never be caller-controlled free text. These tests pin the closed
 * registry: they are the reason an arbitrary string can't select a path or a Keychain
 * entry.
 */

test("the registry is closed: only known ids pass the guard", () => {
  for (const id of Object.keys(COOKIE_BROWSERS)) expect(isCookieBrowser(id)).toBe(true);
  for (const bad of [
    "../../etc",
    "Chrome Safe Storage",
    "chrome; rm -rf /",
    "CHROME",
    "",
    null,
    undefined,
    42,
    {},
    ["chrome"],
  ]) {
    expect(isCookieBrowser(bad)).toBe(false);
  }
});

test("inherited Object properties don't sneak through the guard", () => {
  // hasOwnProperty (not `in`) — otherwise "constructor"/"toString" would resolve
  // to Object.prototype members and index the registry with undefined.
  for (const proto of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    expect(isCookieBrowser(proto)).toBe(false);
  }
});

test("every entry carries a distinct profile root and Keychain service", () => {
  const roots = new Set<string>();
  const services = new Set<string>();
  for (const [id, cfg] of Object.entries(COOKIE_BROWSERS)) {
    expect(cfg.root.startsWith("Library/Application Support/")).toBe(true);
    expect(cfg.root.includes("..")).toBe(false);
    expect(cfg.keychain.endsWith(" Safe Storage")).toBe(true);
    expect(cfg.label.length).toBeGreaterThan(0);
    expect(roots.has(cfg.root)).toBe(false);
    expect(services.has(cfg.keychain)).toBe(false);
    roots.add(cfg.root);
    services.add(cfg.keychain);
    expect(id).toMatch(/^[a-z]+$/);
  }
});

test("an unknown browser degrades to chrome instead of leaking the attempted path", async () => {
  // Nonexistent profile → the error names the FALLBACK browser, never the input.
  // A thrown "no Dracula Cookies DB at /Users/…" would turn the arg into a probe.
  const bogusProfile = "NoSuchProfile-" + Math.random().toString(36).slice(2);
  let msg = "";
  try {
    await listChromeCookieHosts({ profile: bogusProfile, browser: "dracula" });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  expect(msg).toContain("Google Chrome");
  expect(msg).not.toContain("dracula");
  expect(msg).toContain(bogusProfile);
});
