/**
 * Unit tests for the vision-text de-loop guard (browser_read_screen). Pure
 * logic, no network — verifies a degenerate moondream decode loop can't flood
 * the agent context.
  * @covers VISION-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { clampVisionText, describeImage, pointObject, resetMoondreamCounter } from "./moondream-client";

describe("clampVisionText", () => {
  it("passes short normal text through unchanged", () => {
    const t = "A login form with an email field and a blue Sign in button.";
    expect(clampVisionText(t)).toBe(t);
  });

  it("collapses an infinitely repeated word", () => {
    const out = clampVisionText("error " + "the ".repeat(5000));
    expect(out.length).toBeLessThan(60);
    // collapses to the minimal repeating unit: 3× "the"
    expect(out).toBe("error the the the");
  });

  it("collapses a repeated phrase (n-gram loop)", () => {
    const out = clampVisionText(("page not found ").repeat(2000).trim());
    expect(out.length).toBeLessThan(200);
    expect(out.startsWith("page not found page not found page not found")).toBe(true);
  });

  it("collapses repeated lines", () => {
    const out = clampVisionText(Array(500).fill("Loading...").join("\n"));
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("hard-caps very long non-repeating text", () => {
    // distinct tokens so the de-loop can't shrink it — only the cap applies
    const words = Array.from({ length: 6000 }, (_, i) => `w${i}`).join(" ");
    const out = clampVisionText(words);
    expect(out.length).toBeLessThanOrEqual(2000 + "…[truncated]".length);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("handles empty/whitespace input", () => {
    expect(clampVisionText("")).toBe("");
    expect(clampVisionText("   \n  ")).toBe("");
  });
});

/**
 * A rejected KEY is not a bad gateway, and it is not transient. What the agent
 * gets back has to say which of the two it is, and it must not also spend the
 * pane's vision budget on a call that bought nothing.
 * @covers VISION-01
 */
describe("vision provider errors", () => {
  const CTX = "ctx-vision-errors";
  const IMG = "aGVsbG8="; // any base64: the fetch is stubbed, the bytes are never read
  const realFetch = globalThis.fetch;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.MOONDREAM_API_KEY;
    process.env.MOONDREAM_API_KEY = "test-key";
    resetMoondreamCounter(CTX);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.MOONDREAM_API_KEY;
    else process.env.MOONDREAM_API_KEY = savedKey;
    resetMoondreamCounter(CTX);
  });

  function stubFetch(status: number, body: string): void {
    globalThis.fetch = (async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  it("names the rejected key, says it will not fix itself, and points at the tools that work", async () => {
    stubFetch(401, JSON.stringify({ error: "Unauthorized" }));
    const out = await describeImage({ contextId: CTX, imageBase64: IMG });
    expect("error" in out).toBe(true);
    const msg = (out as { error: string }).error;
    expect(msg).toContain("MOONDREAM_API_KEY");
    expect(msg).toContain("401");
    expect(msg).toContain("not a transient one");
    expect(msg).toContain("browser_get_text");
  });

  it("does not charge the vision budget for a call the provider refused to authorize", async () => {
    stubFetch(401, "nope");
    await describeImage({ contextId: CTX, imageBase64: IMG });
    await describeImage({ contextId: CTX, imageBase64: IMG });
    // Only the successful call is charged: with the default budget of 20 the
    // first one that actually answers must report 19 left, not 17.
    stubFetch(200, JSON.stringify({ caption: "a page" }));
    const ok = await describeImage({ contextId: CTX, imageBase64: IMG });
    expect(ok).toEqual({ text: "a page", callsRemaining: 19 });
  });

  it("keeps a non-auth provider failure charged and reported as-is", async () => {
    stubFetch(500, "boom");
    const out = await describeImage({ contextId: CTX, imageBase64: IMG });
    expect((out as { error: string }).error).toBe("Moondream API error: HTTP 500");
    stubFetch(200, JSON.stringify({ caption: "a page" }));
    const ok = await describeImage({ contextId: CTX, imageBase64: IMG });
    expect(ok).toEqual({ text: "a page", callsRemaining: 18 });
  });

  it("tells browser_point the same thing, in its own name", async () => {
    stubFetch(403, "forbidden");
    const out = await pointObject({
      contextId: CTX, imageBase64: IMG, description: "the login button",
      viewport: { width: 100, height: 100 },
    });
    expect((out as { error: string }).error).toContain("browser_point");
    expect((out as { error: string }).error).toContain("403");
  });
});
