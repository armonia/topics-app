/**
 * TURNING ON FLOATING SPLITS MOVES THE GAPS, NOT THE GROUND.
 *
 * The feature detaches every split into a rounded card with a small gap. On
 * macOS the shell deliberately goes transparent underneath: per-region vibrancy
 * paints behind the cards, so the gaps fall through to the live desktop. On
 * Windows there is no per-region vibrancy at all — DWM backdrops are
 * whole-window, and `useFloatingVibrancy` says so in as many words — so taking
 * the shell's background away does not open the gaps: it drops the WHOLE window
 * onto the desktop blur.
 *
 * That is what shipped, unconditionally, and what a person saw, reported on
 * 30/08 and quoted here in their own words:
 * "quando metto floating windows cambia lo sfondo finestre ma non dovrebbe" allow-italian: the report is quoted verbatim
 *
 * WHY THIS IS MEASURED ON A CLASS AND NOT BY DRIVING THE SETTING. The preference
 * only renders on a desktop shell (`isDesktop`), which a Playwright page is not,
 * and the platform itself is carried by a class on `<html>` (`windows-acrylic`,
 * `tauri-mac`) set by `boot.js` and re-asserted by the hook. So the honest test
 * is the one the CSS actually resolves: the real bundle, the real cascade, the
 * two platform classes, the class toggled on the shell element. Measured on
 * Windows' own engine before the fix: the ground went from
 * `rgba(234, 236, 240, 0.72)` to `rgba(0, 0, 0, 0)`.
 *
 * @covers LAYOUT-32
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Read the shell's ground with a platform class on, floating off then on. */
async function ground(page: import("@playwright/test").Page, platformClass: string) {
  return page.evaluate((cls) => {
    const root = document.documentElement;
    const before = root.className;
    const shell = document.createElement("div");
    // The shell's own classes, as App.tsx builds them.
    shell.className = "flex bg-app-bg overflow-hidden max-w-[100vw]";
    shell.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;height:100px";
    document.body.appendChild(shell);
    root.className = `${cls} native-frost`;
    const read = () => getComputedStyle(shell).backgroundColor;
    const off = read();
    shell.classList.add("floating-splits");
    const on = read();
    root.className = before;
    shell.remove();
    return { off, on };
  }, platformClass);
}

const TRANSPARENT = /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/;

test.describe("Floating splits and the window's ground", () => {
  // ONE test, because it is ONE invariant with two arms: the transparency must
  // happen exactly where something paints behind it. Asserting only the Windows
  // half would pass on a build that removed the feature altogether.
  test("LAYOUT-32: the ground stays on Windows and goes only where vibrancy paints", async ({ page }) => {
    await goToApp(page);

    const win = await ground(page, "windows-acrylic");
    expect(
      win.off,
      "il guscio deve avere un fondo da confrontare: se e' gia' trasparente da spento, questo test non misura niente",
    ).not.toMatch(TRANSPARENT);
    expect(
      win.on,
      `accendere i pannelli fluttuanti ha cambiato il fondo della finestra su Windows (${win.off} -> ${win.on}): ` +
        "li' non c'e' vibrancy per-regione dietro cui cadere, quindi la finestra intera finisce sulla sfocatura del desktop",
    ).toBe(win.off);

    for (const cls of ["tauri-mac", "electron-mac"]) {
      const mac = await ground(page, cls);
      expect(
        mac.on,
        `con \`${cls}\` il guscio deve sparire: e' la vibrancy per-regione a dipingere nei vuoti, ` +
          "e un fondo opaco li' li farebbe leggere come grigio piatto",
      ).toMatch(TRANSPARENT);
    }
  });
});
