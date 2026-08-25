/**
 * The two ways `shouldForgetLastUrl` could be wrong, and only one of them is
 * visible.
 *
 * Too eager and it throws away a good page because the machine was offline for
 * a minute: the person reopens the pane and their site is gone, and nothing in
 * the log says why. Too shy and nothing changes: the dead preview port keeps
 * costing an 8s timeout on every context creation. The rule needs BOTH halves,
 * so both halves are tested on their own.
 * @covers BROWSER-CHAT-01
 */
import { describe, expect, it } from "bun:test";
import { shouldForgetLastUrl } from "./browser-state-store";

const REFUSED = "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8791/report.html";

describe("shouldForgetLastUrl", () => {
  it("forgets a dead loopback port, which is what actually fills the log", () => {
    expect(shouldForgetLastUrl("http://localhost:8791/report.html", REFUSED)).toBe(true);
    expect(shouldForgetLastUrl("http://127.0.0.1:8791/review.html", REFUSED)).toBe(true);
    expect(shouldForgetLastUrl("http://192.168.1.40:3000/", "net::ERR_ADDRESS_UNREACHABLE")).toBe(true);
    expect(shouldForgetLastUrl("http://macbook:5173/", "net::ERR_NAME_NOT_RESOLVED")).toBe(true);
  });

  it("KEEPS a public site: a refused connection there is a bad minute, not a dead port", () => {
    expect(shouldForgetLastUrl("https://github.com/anthropics", REFUSED)).toBe(false);
    expect(shouldForgetLastUrl("https://example.com/", "net::ERR_NAME_NOT_RESOLVED")).toBe(false);
  });

  it("KEEPS a private host that failed for a reason other than nobody listening", () => {
    // The port answered and then the page misbehaved: the server is alive.
    expect(shouldForgetLastUrl("http://localhost:3200/login", "Timeout 8000ms exceeded")).toBe(false);
    expect(shouldForgetLastUrl("http://localhost:3200/login", "net::ERR_ABORTED")).toBe(false);
  });

  it("does not choke on a url that is not one", () => {
    expect(shouldForgetLastUrl("not a url", REFUSED)).toBe(false);
    expect(shouldForgetLastUrl("", REFUSED)).toBe(false);
  });
});
