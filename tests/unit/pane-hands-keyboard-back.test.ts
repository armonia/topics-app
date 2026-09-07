/**
 * @covers NATIVEOPS-05
 *
 * OPENING A BROWSER PANE MUST NOT TAKE THE KEYBOARD AWAY FROM THE CLIENT.
 *
 * WHAT IT COST. Topics 2.2.287 shipped the pane that never showed a page on
 * Windows, and the pane was never the problem. Measured on the real machine on
 * 2026-09-07 (card 99a9a8bd): the pane's WebView2 is created, positioned on the
 * exact rect of its layout slot, navigates over loopback and over the internet,
 * and paints - 73.6% of the window, read identically by `PrintWindow` and by a
 * screen grab. What never arrived was the ADDRESS. A WebView2 created as a
 * child takes the keyboard the instant it exists, the client's freshly focused
 * address bar loses it (`document.activeElement` falls back to BODY), and every
 * key from then on is delivered to a page parked off-screen. From the outside
 * that is indistinguishable from a dead pane: you open it, you type, nothing.
 *
 * AND NOTHING GAVE IT BACK. `browser_release_focus` - the command whose whole
 * job is to return the keyboard to the UI webview, called by the tab strip on
 * pointer-down - was written for macOS only; the other arm was
 * `let _ = (app, window_label)`. On macOS AppKit hands the first responder back
 * on its own often enough that nobody noticed; on Windows the focus lives
 * inside the WebView2 controller and ONLY the app can move it: a `SetFocus` on
 * the client's child HWND from outside was tried on the same machine and the
 * client still received nothing. The instruction that works is
 * `MoveFocus(PROGRAMMATIC)`, which is what wry does for `Webview::set_focus`,
 * so the fix is that one portable line and not a per-engine twin.
 *
 * WHAT IT READS. The non-macOS arm of the shell: that a pane creation hands the
 * keyboard back to the host window's UI webview, that `browser_release_focus`
 * has a body there at all, and that neither engine backend grew a hand-written
 * copy of what `set_focus` already does.
 *
 * WHAT IT DOES NOT CLAIM. That the keyboard reaches the client on Windows -
 * that is measured on real hardware by `tools/win-browser-probe.sh`, which
 * reports the focused window and a TCP witness of what the pane actually
 * requested. This holds the SHAPE, which is readable from any machine.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src");
const lib = readFileSync(join(SRC, "lib.rs"), "utf8");
const win = readFileSync(join(SRC, "browser_win.rs"), "utf8");
const linux = readFileSync(join(SRC, "browser_linux.rs"), "utf8");

/** The slice of a function body, from its signature to the next `fn` at column 0. */
function body(rust: string, signature: string): string {
  const start = rust.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const rest = rust.slice(start + signature.length);
  const end = rest.search(/\n(?:pub )?fn /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("a native pane hands the keyboard back", () => {
  test("creating a pane returns the keyboard to the host window's UI webview", () => {
    const open = body(lib, "fn browser_open_inner(");
    expect(open).toContain('#[cfg(not(target_os = "macos"))]');
    // The host window, not always `main`: a pane opened in a pop-out has to give
    // the keyboard back to the pop-out that hosts it.
    expect(open).toMatch(/get_webview\(window\.label\(\)\)[\s\S]{0,200}set_focus\(\)/);
  });

  test("browser_release_focus has a body outside macOS", () => {
    const release = body(lib, "fn browser_release_focus_inner(");
    expect(release).toContain("set_focus()");
    // The dead arm that shipped in 2.2.287: everything that was not macOS fell
    // into one discard, so the command the tab strip calls did nothing at all.
    expect(release).not.toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*\n\s*let _ = \(app, window_label\);/);
  });

  test("neither engine backend grew a hand-written focus call", () => {
    // `Webview::set_focus` already IS `MoveFocus(PROGRAMMATIC)` on WebView2 and
    // `grab_focus` on WebKitGTK, so a per-engine twin here would be two
    // functions saying what one line says, on branches this machine cannot
    // compile.
    expect(win).not.toContain("MoveFocus(");
    expect(linux).not.toContain("grab_focus(");
  });
});
