/**
 * The answer of `open_browser_pane` against the pane's own address.
 *
 * The defect these two functions close: the tool reported the URL it had been
 * ASKED for, so a navigation that never happened read as a success and the
 * white pane reached the user with nobody upstream knowing.
 *
 * @covers BROWSER-01
 */
import { describe, test, expect } from "bun:test";
import { blankPaneFailure, settledUrl } from "./pane-nav-outcome";

const REF = "/api/media?path=%2Ftmp%2Fspec.pdf";

describe("blankPaneFailure", () => {
  test("a real request answered by a blank view is a failure, with the reason", () => {
    const msg = blankPaneFailure("http://127.0.0.1:8899/x.pdf", "about:blank");
    expect(msg).toContain("never loaded");
    expect(msg).toContain("http://127.0.0.1:8899/x.pdf");
  });

  test("a view that cannot even say where it is counts as blank", () => {
    expect(blankPaneFailure(REF, "")).not.toBeNull();
  });

  test("asking for the blank page and getting it is not a failure", () => {
    expect(blankPaneFailure("about:blank", "about:blank")).toBeNull();
  });

  test("a page that loaded is never a failure", () => {
    expect(blankPaneFailure("https://example.com", "https://example.com/")).toBeNull();
    expect(blankPaneFailure(REF, `http://127.0.0.1:13333${REF}`)).toBeNull();
  });
});

describe("settledUrl", () => {
  test("the media reference stays relative when the view is on that same document", () => {
    // The tab is a durable record: pinning it to the origin THIS client used
    // (the desktop proxy) breaks it for the phone that opens it next.
    expect(settledUrl(REF, `http://127.0.0.1:13333${REF}`)).toBe(REF);
  });

  test("a genuine redirect wins over the request", () => {
    expect(settledUrl("https://a.test/", "https://b.test/landed")).toBe("https://b.test/landed");
    expect(settledUrl(REF, "http://127.0.0.1:13333/api/media?path=%2Ftmp%2Fother.pdf")).toBe(
      "http://127.0.0.1:13333/api/media?path=%2Ftmp%2Fother.pdf",
    );
  });

  test("no answer from the view leaves the request standing", () => {
    expect(settledUrl(REF, "")).toBe(REF);
  });
});
