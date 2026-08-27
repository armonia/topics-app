/**
 * browser_act on a ref the page no longer carries.
 *
 * A ref is a POSITION in the last listing, not an identity: any re-render
 * renumbers in DOM order. The old behaviour handed the caller back a bare "ref 2
 * not found on the page (stale snapshot? call browser_observe again, then act)",
 * which costs a whole round trip to learn something the server could see by
 * looking. Now the server looks: it re-snapshots, follows the element when the
 * identity is unambiguous, and otherwise fails with the fresh listing attached.
 * @covers BROWSER-CHAT-01
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { handleBrowserAct, clearBrowserCaches } from "./browser-tools-handler";
import type { BrowserService } from "./browser-service";
import type { Snapshot } from "../shared/browser-snapshot-core";

const CTX = "ctx-stale";

function snap(elements: Snapshot["elements"], url = "https://example.test/"): Snapshot {
  return { url, title: "T", scrollY: 0, scrollMaxY: 0, elements, truncated: false };
}

/** A Playwright-shaped page whose DOM is one snapshot object we can swap. */
function fakePage(initial: Snapshot) {
  const acted: Array<{ ref: number; action: string }> = [];
  let current = initial;
  const refsOnPage = () => new Set(current.elements.map((e) => e.ref));
  const page = {
    evaluate: async () => JSON.parse(JSON.stringify(current)) as Snapshot,
    locator: (selector: string) => {
      const ref = Number(/data-topics-ref="(\d+)"/.exec(selector)?.[1] ?? NaN);
      const handle = {
        first: () => handle,
        waitFor: async () => {
          if (!refsOnPage().has(ref)) throw new Error("timeout");
        },
        click: async () => { acted.push({ ref, action: "click" }); },
      };
      return handle;
    },
    waitForLoadState: async () => {},
  };
  return {
    page,
    acted,
    setPage: (s: Snapshot) => { current = s; },
  };
}

function serviceFor(page: unknown): BrowserService {
  return {
    getOrCreate: async () => ({ page }),
    broadcastAgentActive: () => {},
  } as unknown as BrowserService;
}

const HOME = { ref: 1, role: "link", name: "Home" };
const GO = { ref: 2, role: "button", name: "Go" };
const SUBMIT = { ref: 3, role: "button", name: "Submit" };

describe("handleBrowserAct — stale ref", () => {
  beforeEach(() => { clearBrowserCaches(CTX); });

  test("the element moved to another number: acts on it, once, and says so", async () => {
    const dom = fakePage(snap([HOME, GO, SUBMIT]));
    const service = serviceFor(dom.page);

    // A first act seeds the handler's snapshot cache, exactly as a real session does.
    await handleBrowserAct(service, CTX, { ref: 1, action: "click" });

    // The nav collapses: everything renumbers in DOM order and "Submit", which
    // was [3], is [2] now. Nothing carries the number the caller was given.
    dom.setPage(snap([
      { ref: 1, role: "button", name: "Go" },
      { ref: 2, role: "button", name: "Submit" },
    ]));

    const out = await handleBrowserAct(service, CTX, { ref: 3, action: "click" });
    expect(dom.acted).toEqual([{ ref: 1, action: "click" }, { ref: 2, action: "click" }]);
    expect(out.ref).toBe(2);
    expect(out.snapshot).toContain("ref 3 was stale");
    expect(out.snapshot).toContain("[2]");
  });

  test("two identical elements: no guessing, and the error CARRIES the fresh listing", async () => {
    const dom = fakePage(snap([HOME, GO]));
    const service = serviceFor(dom.page);
    await handleBrowserAct(service, CTX, { ref: 1, action: "click" });

    // The row was duplicated: following "Go" would mean picking one at random.
    dom.setPage(snap([
      { ref: 1, role: "link", name: "Home" },
      { ref: 5, role: "button", name: "Go" },
      { ref: 6, role: "button", name: "Go" },
    ]));

    let message = "";
    try {
      await handleBrowserAct(service, CTX, { ref: 2, action: "click" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("not found on the page");
    expect(message).toContain("Fresh snapshot");
    expect(message).toContain('[5] button "Go"');
    // Nothing was clicked beyond the first, deliberate act.
    expect(dom.acted).toEqual([{ ref: 1, action: "click" }]);
  });

  test("the page navigated away: identity does not carry over, so no retry", async () => {
    const dom = fakePage(snap([HOME, GO]));
    const service = serviceFor(dom.page);
    await handleBrowserAct(service, CTX, { ref: 1, action: "click" });

    dom.setPage(snap([{ ref: 7, role: "button", name: "Go" }], "https://elsewhere.test/"));

    await expect(handleBrowserAct(service, CTX, { ref: 2, action: "click" })).rejects.toThrow(
      /not found on the page/,
    );
    expect(dom.acted).toEqual([{ ref: 1, action: "click" }]);
  });
});
