/**
 * The tab sheet from a test: the one surface a tab's right click, long press,
 * Shift+F10 and (on a browser tab) click open (TABSHEET-01). Its commands sit
 * on a first level and in levels beside it (TABSHEET-02), so a test that used
 * to right-click a tab and click an item now opens the item's level first.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type TabSheetLevel = "page" | "tools" | "session" | "tab" | "layout" | "move-to-group";

/** The open tab sheet (there is one at a time). */
export function tabSheet(page: Page): Locator {
  return page.getByTestId("tab-sheet");
}

/** Right-click `tab` and wait for its sheet. */
export async function openTabSheet(page: Page, tab: Locator): Promise<Locator> {
  await tab.click({ button: "right" });
  const sheet = tabSheet(page);
  await expect(sheet).toBeVisible({ timeout: 5_000 });
  return sheet;
}

/** Open a level of the open sheet with a click, and return its panel. */
export async function openSheetLevel(page: Page, level: TabSheetLevel): Promise<Locator> {
  await page.getByTestId(`tab-sheet-level-${level}`).click();
  const panel = page.getByTestId(`tab-sheet-level-${level}-menu`);
  await expect(panel).toBeVisible({ timeout: 3_000 });
  return panel;
}

/**
 * Right-click `tab`, open `level` when given, and click the row named `item`
 * (exact text) inside it.
 */
export async function chooseFromTabSheet(
  page: Page,
  tab: Locator,
  item: string | RegExp,
  level?: TabSheetLevel,
): Promise<void> {
  await openTabSheet(page, tab);
  const scope = level ? await openSheetLevel(page, level) : tabSheet(page);
  const row = scope.getByRole("menuitem", { name: item, exact: typeof item === "string" });
  await expect(row.first()).toBeVisible({ timeout: 3_000 });
  await row.first().click();
}

/** The levels, in the order the sheet draws them. */
const LEVELS: TabSheetLevel[] = ["page", "tools", "session", "tab", "layout"];

/**
 * The row `testId` of the open sheet, wherever the shape put it: on the first
 * level, or inside the level that holds it (a level with one row lifts it to
 * the first level, so a test cannot know in advance). The level that holds it
 * is left open. Null when no level holds it, every level having been looked
 * into while open: that is what makes an ABSENCE assertion mean something.
 */
export async function findInTabSheet(page: Page, testId: string): Promise<Locator | null> {
  const sheet = tabSheet(page);
  await expect(sheet).toBeVisible({ timeout: 5_000 });
  const onFirst = sheet.getByTestId(testId);
  if (await onFirst.count()) return onFirst.first();
  for (const level of LEVELS) {
    const row = page.getByTestId(`tab-sheet-level-${level}`);
    if (!(await row.count())) continue;
    const panel = await openSheetLevel(page, level);
    const inside = panel.getByTestId(testId);
    if (await inside.count()) return inside.first();
  }
  return null;
}

/** Like `findInTabSheet`, for a row that must be there: the bare locator when
 *  it is not, so the caller's own expectation fails with its own message. */
export async function revealInTabSheet(page: Page, testId: string): Promise<Locator> {
  return (await findInTabSheet(page, testId)) ?? page.getByTestId(testId).first();
}

/**
 * The row named `name` (exact text) of the open sheet, wherever it is: the
 * first level, or the level that holds it, left open. Null when no level
 * holds it, every level having been looked into while open.
 */
export async function findRowInTabSheet(page: Page, name: string): Promise<Locator | null> {
  const sheet = tabSheet(page);
  await expect(sheet).toBeVisible({ timeout: 5_000 });
  const onFirst = page.getByTestId("tab-sheet-commands").getByRole("menuitem", { name, exact: true });
  if (await onFirst.count()) return onFirst.first();
  for (const level of LEVELS) {
    const row = page.getByTestId(`tab-sheet-level-${level}`);
    if (!(await row.count())) continue;
    const panel = await openSheetLevel(page, level);
    const inside = panel.getByRole("menuitem", { name, exact: true });
    if (await inside.count()) return inside.first();
  }
  return null;
}

/** Right-click `tab` and choose the row named `name`, wherever it lives. */
export async function chooseInTabSheet(page: Page, tab: Locator, name: string): Promise<void> {
  await openTabSheet(page, tab);
  const row = await findRowInTabSheet(page, name);
  expect(row, `the sheet offers «${name}»`).not.toBeNull();
  await row!.click();
}

/** Close the open sheet, one Esc per open level and one for the sheet. */
export async function closeTabSheet(page: Page): Promise<void> {
  for (let i = 0; i < 4 && (await tabSheet(page).count()); i++) await page.keyboard.press("Escape");
  await expect(tabSheet(page)).toHaveCount(0);
}

/**
 * Move `tab` to the group named `group` (the new-group row makes one) from
 * its sheet: the Layout level, then the move-to-group level inside it.
 */
export async function moveTabToGroupViaSheet(page: Page, tab: Locator, group: string): Promise<void> {
  await openTabSheet(page, tab);
  await openSheetLevel(page, "layout");
  const groups = await openSheetLevel(page, "move-to-group");
  const row = groups.getByRole("menuitem", { name: group });
  await expect(row, `the group «${group}» is offered`).toBeVisible({ timeout: 3_000 });
  await row.click();
}
