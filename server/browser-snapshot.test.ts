/**
 * Unit tests for the vendored ref-based snapshot engine (pure half).
 * serialize() + diff() have no Playwright dependency, so they run under bun:test.
 * @covers BROWSER-CHAT-03
 */
import { describe, expect, it } from "bun:test";
import { serialize, diff, type Snapshot, type SnapElement } from "./browser-snapshot";
import { isStaleRefError, refAfterResnapshot } from "../shared/browser-snapshot-core";

function snap(elements: SnapElement[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    url: "https://example.com/",
    title: "Example",
    scrollY: 0,
    scrollMaxY: 0,
    elements,
    truncated: false,
    ...over,
  };
}

describe("serialize", () => {
  it("renders the compact ref line format", () => {
    const s = snap([
      { ref: 1, role: "link", name: "Home" },
      { ref: 2, role: "textbox", name: "Email", type: "email", value: "a@b" },
      { ref: 3, role: "button", name: "Sign in" },
    ]);
    const text = serialize(s);
    expect(text).toContain('[1] link "Home"');
    expect(text).toContain('[2] textbox "Email" <email> ="a@b"');
    expect(text).toContain('[3] button "Sign in"');
    expect(text).toContain("3 interactive element(s):");
    expect(text).toContain("url: https://example.com/");
  });

  it("flags checked/disabled and truncation, and emits scroll only when scrollable", () => {
    const s = snap(
      [
        { ref: 1, role: "checkbox", name: "Agree", checked: true },
        { ref: 2, role: "button", name: "Next", disabled: true },
      ],
      { scrollY: 100, scrollMaxY: 800, truncated: true },
    );
    const text = serialize(s);
    expect(text).toContain("[1] checkbox \"Agree\" [checked]");
    expect(text).toContain("[2] button \"Next\" [disabled]");
    expect(text).toContain("scroll: 100/800");
    expect(text).toContain("(truncated)");
  });

  it("omits the header when asked", () => {
    const text = serialize(snap([{ ref: 1, role: "button", name: "Go" }]), { header: false });
    expect(text).toBe('[1] button "Go"');
  });
});

describe("diff", () => {
  it("returns a full serialization when there is no previous snapshot", () => {
    const next = snap([{ ref: 1, role: "button", name: "Go" }]);
    const d = diff(undefined, next);
    expect(d.full).toBe(true);
    expect(d.changed).toBe(1);
    expect(d.text).toBe(serialize(next));
  });

  it("reports no changes when structure is stable (refs may differ)", () => {
    const prev = snap([{ ref: 1, role: "button", name: "Go" }]);
    const next = snap([{ ref: 7, role: "button", name: "Go" }]); // ref churn, same sig
    const d = diff(prev, next);
    expect(d.changed).toBe(0);
    expect(d.text).toBe("no element changes");
  });

  it("lists added elements", () => {
    const prev = snap([{ ref: 1, role: "button", name: "Go" }]);
    const next = snap([
      { ref: 1, role: "button", name: "Go" },
      { ref: 2, role: "link", name: "Help" },
    ]);
    const d = diff(prev, next);
    expect(d.changed).toBe(1);
    expect(d.text).toContain("+ 1 new:");
    expect(d.text).toContain('[2] link "Help"');
  });

  it("counts removed elements", () => {
    const prev = snap([
      { ref: 1, role: "button", name: "Go" },
      { ref: 2, role: "link", name: "Help" },
    ]);
    const next = snap([{ ref: 1, role: "button", name: "Go" }]);
    const d = diff(prev, next);
    expect(d.changed).toBe(1);
    expect(d.text).toContain("- 1 removed (refs reassigned)");
  });

  it("flags navigation by url change", () => {
    const prev = snap([{ ref: 1, role: "button", name: "Go" }]);
    const next = snap([{ ref: 1, role: "button", name: "Go" }], {
      url: "https://example.com/next",
    });
    const d = diff(prev, next);
    expect(d.navigated).toBe(true);
    expect(d.text).toContain("navigated -> https://example.com/next");
  });
});

describe("refAfterResnapshot (following an element the page renumbered)", () => {
  const before = snap([
    { ref: 1, role: "link", name: "Home" },
    { ref: 2, role: "button", name: "Submit" },
  ]);

  it("follows the element to its new number when the identity is unique", () => {
    const after = snap([
      { ref: 1, role: "button", name: "Close" },
      { ref: 2, role: "link", name: "Home" },
      { ref: 3, role: "button", name: "Submit" },
    ]);
    expect(refAfterResnapshot(before, after, 2)).toBe(3);
  });

  it("refuses to guess between two identical elements", () => {
    const after = snap([
      { ref: 1, role: "button", name: "Submit" },
      { ref: 2, role: "button", name: "Submit" },
    ]);
    expect(refAfterResnapshot(before, after, 2)).toBeUndefined();
  });

  it("refuses across a navigation, an unknown ref, and with no previous snapshot", () => {
    const elsewhere = snap([{ ref: 9, role: "button", name: "Submit" }], { url: "https://other.test/" });
    expect(refAfterResnapshot(before, elsewhere, 2)).toBeUndefined();
    expect(refAfterResnapshot(before, before, 42)).toBeUndefined();
    expect(refAfterResnapshot(undefined, before, 2)).toBeUndefined();
  });

  it("a disabled-turned-enabled element is a DIFFERENT element for this purpose", () => {
    const after = snap([{ ref: 1, role: "button", name: "Submit", disabled: true }]);
    expect(refAfterResnapshot(before, after, 2)).toBeUndefined();
  });
});

describe("isStaleRefError", () => {
  it("recognizes the phrase both actors use, and nothing else", () => {
    expect(isStaleRefError("ref 3 not found on the page (stale snapshot? ...)")).toBe(true);
    expect(isStaleRefError("Timeout 15000ms exceeded")).toBe(false);
    expect(isStaleRefError(undefined)).toBe(false);
  });
});
