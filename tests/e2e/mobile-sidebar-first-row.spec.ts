/**
 * ON THE PHONE, AT REST, THE FIRST ROW OF THE COLUMN SITS UNDER THE TITLE ROW.
 *
 * Found 27/11 while re-shooting the phone for round 3 of tabs and sidebar:
 * with the page just loaded and nothing scrolled, «Automazioni» already sat
 * under «Topics», behind the veil (`.mobile-top-veil`, 86% tint + blur). On
 * WebKit the name read through it next to the title, on Chromium it was a
 * blurred smudge in the same place. The veil is for rows that scroll UNDER
 * the title; the first row at rest belongs below it, the way a native list
 * shows its first row under the bar and lets the bar's material matter only
 * once content travels behind it.
 *
 * Read from the DOM at 375x812 with a finger, on WebKit (the engine of
 * Safari and of the desktop shell), with no notch and with a notch forced
 * through `--sat` (headless WebKit has none, and with the inset at zero a
 * padding that forgets it cannot be told from one that adds it):
 *  - the title row is compact at rest and sits right past the safe area;
 *  - the first row starts below the bottom of the title row;
 *  - the painted gap between the lowest title-row command and the first row
 *    is one step of the column, the same as between two cards and as under
 *    the desktop header (HDRGAP-01).
 *
 * `MOBILE_FIRST_ROW_SHOTS` names a folder for the shot at rest, so the same
 * file captures the before and the after.
 *
 * @covers MOBILE-CHROME-07
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";
import { COLUMN_GAP, MOBILE_SIDEBAR_HEADER_H_COMPACT } from "../../client/src/lib/selectionStyles";

hermetic(test);
const SIDE_TABS = { cookies: [], origins: [{ origin: E2E_BASE, localStorage: [{ name: "app-settings", value: JSON.stringify({ tabsPosition: "side" }) }] }] };
test.use({ storageState: SIDE_TABS, viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

/** No notch, and the inset of a notched iPhone in portrait. */
const NOTCHES = [0, 47];
const SHOTS = process.env.MOBILE_FIRST_ROW_SHOTS;

/** The title row, its lowest command and the first row of the list, in viewport pixels. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const column = document.querySelector('[aria-label="Topics sidebar"]')!;
    const header = column.querySelector<HTMLElement>(".sidebar-header")!;
    const scroller = column.querySelector<HTMLElement>(".sidebar-column")!;
    const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const hr = header.getBoundingClientRect();
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(shown);
    const first = rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    return {
      compact: header.getAttribute("data-compact"),
      headerTop: hr.top,
      headerBottom: hr.bottom,
      inkBottom: Math.max(...Array.from(header.querySelectorAll("button")).filter(shown).map((b) => b.getBoundingClientRect().bottom)),
      firstTop: first ? first.getBoundingClientRect().top : null,
      firstName: first?.textContent?.trim().slice(0, 40) ?? null,
      scrollTop: scroller.scrollTop,
    };
  });
}

test.describe("the phone column at rest", () => {
  const made: string[] = [];
  let projectPath = "";
  let chatId = "";

  test.beforeAll(async ({ request }) => {
    // A real-looking project: the shot goes in front of a person (25/11, no
    // ids in names). Uniqueness lives in the folder above it.
    projectPath = join(canonicalTmpDir("e2e-phone-first-row"), "sito-armonia");
    mkdirSync(projectPath, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=e2e@e.test", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "start");
    for (const f of ["index.html", "styles.css", "app.js"]) writeFileSync(join(projectPath, f), f);
    chatId = (await createTopic(request, "Rifinire la landing", { projectPath, provider: "claude-code" })).id;
    made.push(chatId);
  });

  test.afterAll(async ({ request }) => {
    await resetPaneStore(request, []).catch(() => {});
    for (const id of made) await deleteTopic(request, id).catch(() => {});
    if (projectPath) removeTmpDir(join(projectPath, ".."));
  });

  for (const notch of NOTCHES) {
    test(`notch ${notch}px: the first row starts one step under the title row`, async ({ page, request }) => {
      test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-07" });
      await resetPaneStore(request, []);
      await seedProjectPane(request, projectPath);
      await seedProjectInnerChats(request, projectPath, [chatId]);
      await page.goto("/?windowChrome=mac");
      // The list is a lazy chunk: wait for the project row, not for the column.
      await expect(projectRow(page, "sito-armonia")).toBeVisible({ timeout: 20_000 });
      await page.evaluate((v) => {
        document.documentElement.style.setProperty("--sat", `${v}px`);
        window.dispatchEvent(new Event("resize"));
      }, notch);
      await waitForLayoutSettled(page, '[aria-label="Topics sidebar"]');

      const m = await measure(page);
      test.info().annotations.push({ type: "misure", description: JSON.stringify(m) });
      if (SHOTS && notch === 0) {
        // The dot beside the title pulses orange until the socket connects:
        // shoot once it has, so two shots differ only by what changed.
        await expect(page.getByTestId("connection-status")).not.toHaveAttribute("data-alarm", { timeout: 15_000 });
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, "telefono-375.png") });
      }

      expect(m.scrollTop, "the list is at rest").toBe(0);
      expect(m.compact, "at rest the title row is the compact one").toBe("true");
      expect(Math.round(m.headerBottom - m.headerTop), "compact title row").toBe(MOBILE_SIDEBAR_HEADER_H_COMPACT);
      expect(Math.round(m.headerTop), "the title row sits right past the safe area").toBe(notch);
      expect(m.firstTop, "a first row in the list").not.toBeNull();
      expect(
        m.firstTop!,
        `«${m.firstName}» starts at ${m.firstTop}, under the title row that ends at ${m.headerBottom}`,
      ).toBeGreaterThanOrEqual(m.headerBottom);
      expect(
        Math.round(m.firstTop! - m.inkBottom),
        `painted gap between the title row's commands (${m.inkBottom}) and «${m.firstName}» (${m.firstTop})`,
      ).toBe(COLUMN_GAP);
    });
  }
});
