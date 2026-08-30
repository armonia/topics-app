/**
 * TURNING ON FLOATING SPLITS MOVES THE GAPS, NOT THE GROUND UNDER THE CONTENT.
 *
 * The feature detaches every split into a rounded card with a small gap, so the
 * native material shows between them. What it must NOT do is change what is
 * under the CONTENT — the middle of a chat, of a terminal, of the board.
 *
 * WHY THAT WAS EASY TO GET WRONG, and it was, twice. Under `.native-frost`
 * nothing else in the tree paints: `html`/`body`/`#root`, `#main-content`,
 * `.content-flip-layer`, the sidebar and every `.chrome-glass` are explicitly
 * transparent. The ONE coloured layer in the whole window is the shell
 * wrapper's `bg-app-bg` -> `--bg`, a 0.72 veil over the native material. The
 * old rule zeroed exactly that, so it did not open the 4px gaps: it took the
 * veil off EVERYTHING, and the centre of a chat jumped from the composite
 * (20.6, 22.0, 24.4) to bare vibrancy (53, 53, 51) - about 32 levels per
 * channel. Reported, in their own words:
 * "quando metto floating windows cambia lo sfondo finestre ma non dovrebbe" allow-italian: the report is quoted verbatim
 *
 * The first cure gated that rule to the macOS classes. On macOS `.tauri-mac`
 * always matches, so it was a literal no-op there and the report came back
 * unchanged. The lesson is in what this file measures now: not the shell's
 * background - which is ALLOWED to go bare, that is what makes a gap a gap -
 * but the ground a person actually looks at, wherever the veil happens to ride.
 *
 * WHY ON A CLASS AND NOT BY DRIVING THE SETTING. The preference only renders on
 * a desktop shell (`isDesktop`), which a Playwright page is not, and the
 * platform is carried by a class on `<html>` (`windows-acrylic`, `tauri-mac`)
 * set by `boot.js`. So the test drives the real cascade with the real bundle:
 * the two platform classes, the class toggled on the shell.
 *
 * @covers LAYOUT-32
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const CLEAR = /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/;

/**
 * The ground over a split card, floating off then on.
 *
 * "Ground" is the topmost painted layer above that area: the card's own
 * background when it has one, else the shell's. That indirection is the point —
 * the veil is allowed to MOVE between the two, and a person cannot tell which
 * element paints it. What they can tell is the colour.
 */
async function groundOverContent(page: import("@playwright/test").Page, platformClass: string) {
  return page.evaluate((cls) => {
    const root = document.documentElement;
    const before = root.className;
    const shell = document.createElement("div");
    // The shell's own classes, as App.tsx builds them.
    shell.className = "flex bg-app-bg overflow-hidden max-w-[100vw]";
    shell.style.cssText = "position:fixed;left:-9999px;top:0;width:400px;height:200px";
    const card = document.createElement("div");
    card.setAttribute("data-split-card", "");
    card.style.cssText = "width:200px;height:200px";
    shell.appendChild(card);
    document.body.appendChild(shell);
    root.className = `${cls} native-frost`;

    const clear = (c: string) => /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
    const read = () => {
      const onCard = getComputedStyle(card).backgroundColor;
      const onShell = getComputedStyle(shell).backgroundColor;
      return { ground: clear(onCard) ? onShell : onCard, onCard, onShell };
    };
    const off = read();
    shell.classList.add("floating-splits");
    const on = read();
    root.className = before;
    shell.remove();
    return { off, on };
  }, platformClass);
}

test.describe("Floating splits and the window's ground", () => {
  // ONE test, because it is ONE invariant across every platform: the ground a
  // person looks at is the same before and after, and the shell is free to go
  // bare underneath so the gaps can exist at all.
  test("LAYOUT-32: the ground under the content does not move, on any platform", async ({ page }) => {
    await goToApp(page);

    for (const cls of ["windows-acrylic", "tauri-mac", "electron-mac"]) {
      const g = await groundOverContent(page, cls);
      expect(
        g.off.ground,
        `con \`${cls}\` il guscio deve avere un fondo da confrontare: se e' gia' nudo da spento, questo test non misura niente`,
      ).not.toMatch(CLEAR);
      expect(
        g.on.ground,
        `con \`${cls}\` accendere i pannelli fluttuanti ha cambiato il terreno SOTTO IL CONTENUTO ` +
          `(${g.off.ground} -> ${g.on.ground}): il velo deve spostarsi sulle schede, non sparire. ` +
          `Guscio ${g.off.onShell} -> ${g.on.onShell}, scheda ${g.off.onCard} -> ${g.on.onCard}`,
      ).toBe(g.off.ground);
    }
  });

  // The other half, and it is what keeps the fix from being "just paint it all
  // opaque again": the SHELL has to go bare, or there are no gaps to see.
  test("LAYOUT-32b: the shell goes bare underneath, so a gap is a gap", async ({ page }) => {
    await goToApp(page);
    const g = await groundOverContent(page, "tauri-mac");
    expect(
      g.on.onShell,
      "il guscio deve restare nudo in modalita' fluttuante: e' lo spazio fra le schede a mostrare il materiale nativo",
    ).toMatch(CLEAR);
    expect(
      g.on.onCard,
      "e la scheda deve portare il velo, altrimenti il terreno sotto il contenuto se ne va con il guscio",
    ).not.toMatch(CLEAR);
  });
});
