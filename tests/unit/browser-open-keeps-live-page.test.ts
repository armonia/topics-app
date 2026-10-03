/**
 * @covers TOPIC-BROWSER-01
 *
 * AN OPEN OF A LIVE VIEW NEVER NAVIGATES IT.
 *
 * WHAT IT COST. `browser_open` on an id whose webview already existed
 * navigated it whenever the requested url differed from the last url the
 * client had asked for, which after any click, redirect or pushState inside
 * the page is every time. Every path that re-sends `browser_open` for a live
 * id reloaded the page and lost what was in it (scroll, forms, SPA state,
 * sometimes the login): a ⌘R of the app, a remount that missed the client's
 * handoff, a move started from another device, a pop-out.
 *
 * WHAT IT READS. The rule itself (`plan_browser_open`) is pinned by the Rust
 * tests in lib.rs (`browser_open_reuse_tests`). What a Rust unit test cannot
 * see is the command that applies it, which needs a live tauri runtime: so
 * this reads `browser_open_inner` and holds its shape. Navigation is not
 * reachable from it at all, the only page load left is the creation of a new
 * view, and the reuse branch answers the view's url.
 *
 * WHAT IT DOES NOT CLAIM. That a reused WKWebView keeps its scroll and its
 * forms: that is only visible in the built app.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src");
const lib = readFileSync(join(SRC, "lib.rs"), "utf8");

/** The slice of a function body, from its signature to the next `fn` at column 0. */
function body(rust: string, signature: string): string {
  const start = rust.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const rest = rust.slice(start + signature.length);
  const end = rest.search(/\n(?:pub )?fn /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("browser_open keeps the page of a live view", () => {
  const open = body(lib, "fn browser_open_inner(");

  test("nothing in browser_open navigates a view", () => {
    expect(open).not.toMatch(/browser_navigate(_inner)?\(/);
    expect(open).not.toMatch(/\.navigate\(/);
  });

  test("the decision goes through plan_browser_open, and the reuse answers the view's url", () => {
    expect(open).toContain("plan_browser_open(");
    expect(open).toMatch(/BrowserOpenAnswer \{ reused: true, url: current \}/);
  });
});
