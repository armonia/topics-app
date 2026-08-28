/**
 * ON WINDOWS THE APP MENU IS NOT BUILT AT ALL.
 *
 * On macOS the native menu is the strip at the top of the SCREEN, and without it
 * a WKWebView shell has no working Cmd+C/V/X/A/Z and no Reload: there it stays.
 * On Windows the same menu is a row inside the WINDOW, right above the app's own
 * chrome (the system frame is off, `set_decorations(false)`), so it is a second
 * bar in a window that draws its own. It buys nothing either: its accelerators
 * never fired, because nothing calls `TranslateAcceleratorW` in the message loop
 * (that is what `menu_chords_win` is for), and every entry it lists is reachable
 * from the app. Reported from a Windows build (card 3198947b).
 *
 * WHY A TEST ON THE SOURCE TEXT. A Mac cannot build the Windows target, so the
 * only thing provable here is that the menu is behind the platform gate - and
 * that is exactly the line somebody deletes by accident while moving the chain
 * around. What it cannot prove (that the window shows no menu row) takes the
 * Windows machine and a screenshot.
 *
 * @covers WINMENU-01
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const LIB = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src", "lib.rs");
const src = readFileSync(LIB, "utf8");

describe("the Windows window carries no menu", () => {
  test("the app menu is built behind a not-windows gate", () => {
    const at = src.indexOf(".menu(|handle|");
    expect(at).toBeGreaterThan(0);
    // The gate sits on the statement right above the call.
    const before = src.slice(Math.max(0, at - 200), at);
    expect(before).toContain('#[cfg(not(target_os = "windows"))]');
  });

  test("one menu only: no second, ungated builder call", () => {
    // The tray has its own menu (`tray.set_menu`), which is a different object
    // and lives on the status area, not in the window.
    expect((src.match(/\.menu\(\|handle\|/g) || []).length).toBe(1);
  });

  test("removed, not hidden", () => {
    // `hide_menu()` leaves the menu attached: any later `show_menu`/`set_menu`,
    // or any window built afterwards inheriting the app-wide menu, brings the
    // row back. Nothing here may reach for it - comments about it are fine, a
    // call is not.
    const calls = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .filter((l) => /\.(hide_menu|show_menu)\(/.test(l));
    expect(calls).toEqual([]);
  });

  test("the menu handler stays: the keyboard chords run the same body", () => {
    expect(src).toContain(".on_menu_event(|app, event| run_menu_action(app, event.id().0.as_str()))");
    expect(src).toContain("fn run_menu_action");
  });
});
