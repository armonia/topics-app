/**
 * Regression coverage for the screenshot → FILE-PATH contract.
 *
 * The bug this locks down: `browser_screenshot` used to return the raw JPEG/PNG
 * as base64 inline, which the agent can't view and which floods its context with
 * tens of thousands of unusable tokens — pushing the turn toward the compact /
 * "Response stalled mid-stream" boundary (observed on the quadra topic). Both the
 * web pane (handleBrowserScreenshot) and the native Tauri pane (dispatcher
 * interception) must now persist the image to disk and hand back a PATH, never a
 * base64 blob.
 * @covers BROWSER-CHAT-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the media root BEFORE the modules that read TOPICS_HOME run their
// (now-lazy) dir resolution, so the test never writes into the real ~/.topics.
let tmpHome: string;
tmpHome = mkdtempSync(join(tmpdir(), "topics-shot-test-"));
process.env.TOPICS_HOME = tmpHome;

import { writeAgentScreenshot, handleBrowserObserve } from "./browser-tools-handler";
import { dispatchBrowserToolCallByContext } from "./browser-tool-dispatcher";
import { nativeDelegateRegistry } from "./browser-native-delegate";
import type { BrowserService } from "./browser-service";

// A 1x1 transparent PNG — enough bytes to prove the file is the decoded image.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const shotDir = () => join(tmpHome, "media", "agent-screenshots");

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("writeAgentScreenshot", () => {
  test("writes the buffer to a file under the media root and returns an absolute path", async () => {
    const buf = Buffer.from(TINY_PNG_B64, "base64");
    const path = await writeAgentScreenshot(buf, "ctx-abc", "png");
    expect(path.startsWith(shotDir())).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(buf.length);
  });

  test("sanitizes a messy contextId into the filename", async () => {
    const path = await writeAgentScreenshot(Buffer.from(TINY_PNG_B64, "base64"), "topic:weird/id space", "jpg");
    expect(path).toMatch(/topic_weird_id_space/);
    expect(path.endsWith(".jpg")).toBe(true);
  });
});

describe("dispatchBrowserToolCallByContext — native browser_screenshot", () => {
  const CTX = "native-pane-1";

  beforeAll(() => {
    // Register a fake native executor that replies with a base64 PNG, mirroring
    // the real tauriBrowserOps { data, mime:'image/png' } shape.
    nativeDelegateRegistry.register(CTX, (msg) => {
      nativeDelegateRegistry.resolveOp({
        opId: msg.opId,
        result: { data: TINY_PNG_B64, mime: "image/png", encoding: "base64" },
      });
    });
  });

  afterAll(() => {
    nativeDelegateRegistry.unregister(CTX);
  });

  test("returns a file PATH, never the base64 data", async () => {
    const service = { setAgentAction() {} } as unknown as BrowserService;
    const result = (await dispatchBrowserToolCallByContext(
      "browser_screenshot",
      {},
      CTX,
      service,
    )) as { format?: string; path?: string; bytes?: number; data?: unknown };

    expect(result.format).toBe("png");
    expect(typeof result.path).toBe("string");
    expect("data" in result).toBe(false); // the whole point: no base64 blob
    expect(existsSync(result.path!)).toBe(true);
    expect(result.bytes).toBe(Buffer.from(TINY_PNG_B64, "base64").length);
  });
});

describe("handleBrowserObserve — the opt-in capture is a file too", () => {
  const CTX = "web-pane-observe";
  // The web pane's annotator hands back base64; the handler must land it on disk
  // and answer with the path, exactly like browser_screenshot does.
  const service = {
    broadcastAgentActive() {},
    getOrCreate: async () => ({
      page: {
        evaluate: async () => ({
          url: "https://example.test/",
          title: "T",
          scrollY: 0,
          scrollMaxY: 0,
          elements: [{ ref: 1, role: "button", name: "Go" }],
          truncated: false,
        }),
      },
    }),
    extractIndexedElements: async () => [],
    captureAnnotatedScreenshot: async () => TINY_PNG_B64,
  } as unknown as BrowserService;

  test("without screenshot:true nothing is captured", async () => {
    const out = await handleBrowserObserve(service, CTX, { full: true });
    expect(out.screenshot_path).toBeUndefined();
    expect(out.snapshot).toContain("[1]");
  });

  test("with screenshot:true the response carries a path to a real file, no pixels", async () => {
    const out = await handleBrowserObserve(service, CTX, { full: true, screenshot: true });
    expect(typeof out.screenshot_path).toBe("string");
    expect(out.screenshot_path!.startsWith(shotDir())).toBe(true);
    expect(existsSync(out.screenshot_path!)).toBe(true);
    // PNG in, .png out: the extension follows the bytes, it is not assumed.
    expect(out.screenshot_path!.endsWith(".png")).toBe(true);
    expect(out.screenshot_boxes).toBe(true);
    expect(JSON.stringify(out)).not.toContain(TINY_PNG_B64);
  });
});

describe("dispatchBrowserToolCallByContext — native browser_observe(screenshot:true)", () => {
  const CTX = "native-pane-observe";

  beforeAll(() => {
    // The native executor answers a snapshot for observe and an image for the
    // screenshot op — it has no annotator, which is the point of the test.
    nativeDelegateRegistry.register(CTX, (msg) => {
      const op = (msg as { tool?: string }).tool;
      nativeDelegateRegistry.resolveOp({
        opId: msg.opId,
        result: op === "browser_screenshot"
          ? { data: TINY_PNG_B64, mime: "image/png", encoding: "base64" }
          : { url: "https://example.test/", title: "T", count: 1, snapshot: '[1] button "Go"', full: true },
      });
    });
  });
  afterAll(() => { nativeDelegateRegistry.unregister(CTX); });

  test("the snapshot comes back WITH a captured file, and says the boxes are not drawn", async () => {
    const service = { setAgentAction() {} } as unknown as BrowserService;
    const out = (await dispatchBrowserToolCallByContext(
      "browser_observe",
      { full: true, screenshot: true },
      CTX,
      service,
    )) as { snapshot?: string; screenshot_path?: string; screenshot_boxes?: boolean };

    expect(out.snapshot).toContain("[1]");
    expect(typeof out.screenshot_path).toBe("string");
    expect(existsSync(out.screenshot_path!)).toBe(true);
    expect(out.screenshot_boxes).toBe(false);
  });
});
