/**
 * @covers TOPIC-BROWSER-01
 *
 * AN OAUTH LOGIN POPUP IS BORN EMPTY, AND ONLY THE WEB ENGINE LOADS IT.
 *
 * WHAT IT COST. A `window.open` with a size (the Apple `usePopup` SDK, Google
 * GIS `ux_mode: popup`) is answered with a real window built by the shell and
 * handed back to the engine. That window was built on the REQUESTED url, and
 * tauri skips its own navigation of a new webview only when the url is exactly
 * `about:blank` (tauri-runtime-wry). So two loads of the same page raced: the
 * shell's (`loadRequest` / `Navigate` / `load_uri`) and the engine's, which
 * carries the opener. The page that asked lost its opener, the popup stayed
 * WHITE after the user confirmed, and `opener.postMessage` - the only way the
 * credential reaches the page - arrived nowhere: the site simply never logged
 * you in (card 9953bbcd, reported 2026-11-22).
 *
 * WHAT IT READS. The two halves of the contract, which are one line each and
 * which a later edit can undo without looking wrong: the popup is built on
 * `about:blank`, and the only thing that builds one is the engine's own
 * new-window request, answered with `Create` so the engine does the load.
 *
 * WHAT IT DOES NOT CLAIM. That a real Apple or Google login completes: that
 * needs a signed-in account on a built app, and it is the human's one gesture.
 * This holds the SHAPE, which is readable from any machine - the shell is
 * Rust and does not compile here.
 */
import { describe, test, expect } from "bun:test";
import { readTauriShellSource, rustFnBody as body } from "../helpers/tauri-shell-source";

const lib = readTauriShellSource();

describe("an OAuth popup keeps the opener of the page that asked for it", () => {
  const popup = body(lib, "fn open_page_popup(");

  test("the popup window is built on about:blank, never on the requested url", () => {
    expect(popup).toMatch(/WebviewUrl::External\(blank\)/);
    // The regression itself: `External(url)` here is the double load that eats
    // the opener. The url is still needed for the title, so the guard is on the
    // builder's argument and not on the whole body.
    expect(popup).not.toMatch(/WebviewWindowBuilder::new\([^)]*External\(url\)/);
    expect(popup).toMatch(/"about:blank"\.parse\(\)/);
  });

  test("nothing in the popup builder loads the page itself", () => {
    expect(popup).not.toMatch(/\.navigate\(/);
    expect(popup).not.toMatch(/eval\(/);
  });

  test("a sized window.open is answered with Create, so the engine loads it", () => {
    const open = body(lib, "fn browser_open_inner(");
    expect(open).toMatch(/features\.size\(\)\.is_some\(\)/);
    expect(open).toMatch(/open_page_popup\(&nw_app, url, features\)[\s\S]{0,200}NewWindowResponse::Create \{ window \}/);
  });
});
