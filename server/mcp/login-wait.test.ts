/**
 * @covers BROWSER-LOGIN-01
 */
import { describe, expect, it } from "bun:test";
import { hasLeftLogin, looksLikeLogin, waitForLoginExit } from "./login-wait";

describe("login detection", () => {
  it("recognises login and second-factor pages", () => {
    expect(looksLikeLogin("https://github.com/login")).toBe(true);
    expect(looksLikeLogin("https://github.com/sessions/two-factor")).toBe(true);
    expect(looksLikeLogin("https://accounts.example.test/o/start")).toBe(true);
    expect(looksLikeLogin("https://github.com/support")).toBe(false);
  });

  it("leaves the login only for a different, non-login page", () => {
    const start = "https://github.com/login";
    expect(hasLeftLogin(start, start)).toBe(false);
    expect(hasLeftLogin(start, "https://github.com/sessions/two-factor")).toBe(false);
    expect(hasLeftLogin(start, "https://github.com/")).toBe(true);
    expect(hasLeftLogin(start, "about:blank")).toBe(false);
  });
});

describe("waitForLoginExit", () => {
  it("resolves logged_in once the page leaves the login", async () => {
    const urls = ["https://x.test/login", "https://x.test/login", "https://x.test/home"];
    let i = 0;
    const r = await waitForLoginExit({
      startUrl: "https://x.test/login",
      readUrl: async () => urls[Math.min(i++, urls.length - 1)],
      timeoutMs: 1000, intervalMs: 1, sleep: async () => {},
    });
    expect(r).toEqual({ status: "logged_in", url: "https://x.test/home" });
  });

  it("times out with the tab still on the login", async () => {
    let t = 0;
    const r = await waitForLoginExit({
      startUrl: "https://x.test/login",
      readUrl: async () => "https://x.test/login",
      timeoutMs: 30 * 60_000, intervalMs: 60_000, sleep: async () => { t += 60_000; }, now: () => t,
    });
    expect(r.status).toBe("timeout");
  });
});

describe("callRequestLogin", () => {
  it("opens a new named tab, raises it detached, then reports logged_in", async () => {
    const { callRequestLogin } = await import("./browser-pane-tools");
    const calls: string[] = [];
    let statusReads = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${url.split("/browser/")[1]} ${init?.body ?? ""}`);
      if (url.endsWith("/open-pane")) return Response.json({ url: "https://x.test/login", title: "", contextId: "ctx1" });
      if (url.endsWith("/status")) return Response.json({ url: ++statusReads > 1 ? "https://x.test/home" : "https://x.test/login" });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const out = await callRequestLogin(
      { baseUrl: "http://127.0.0.1:1", sessionKey: "s" } as never,
      { url: "https://x.test/login", detached: true },
      fetchImpl,
      async () => {},
    );
    expect(out).toContain("logged_in");
    expect(calls[0]).toContain('"name":"Login x.test"');
    expect(calls[1]).toContain('"loginRequest":true');
    expect(calls[1]).toContain('"detached":true');
  });
});
