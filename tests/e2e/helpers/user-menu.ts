import { expect, type Locator, type Page } from "@playwright/test";
import { openProfileMenu } from "./open-perf-panel";

/**
 * EVERY SETTING IS A LEVEL OF THE USER MENU, and these are its doors.
 *
 * The preferences (Appearance, Notifications, View), the devices and, since
 * the Settings window went away, the forms (Plan, Nodes, AI providers, Tools,
 * Calendar) are levels of the user menu: the user card on the desktop, the
 * title menu on the phone (`openProfileMenu` picks). The profile, the
 * followers and the organisation are the Profile tab. A spec asks for the
 * level or the page, never for the row that opens it on one screen only.
 */
const LEVEL_ROW = {
  plan: "topics-menu-plan",
  devices: "profile-menu-devices",
  nodes: "topics-menu-nodes",
  providers: "topics-menu-providers",
  tools: "topics-menu-tools",
  calendar: "topics-menu-calendar",
  appearance: "topics-menu-appearance",
  notifications: "topics-menu-notifications",
  view: "topics-menu-view",
} as const;

export type UserMenuLevelName = keyof typeof LEVEL_ROW;

/** Opens the user menu and one of its levels; hands back the level's panel. */
export async function openUserMenuLevel(page: Page, level: UserMenuLevelName): Promise<Locator> {
  await openProfileMenu(page);
  const row = page.getByTestId(LEVEL_ROW[level]);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const panel = page.getByTestId(`${LEVEL_ROW[level]}-menu`);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/**
 * Asks for a page of your own profile on the two events `apriProfilo` sends
 * (open the Profile utility, then land on the page). Retried, because the
 * listeners exist only once the app has mounted, and the page event is heard
 * by the pane only once the pane is there.
 */
async function requestProfilePage(page: Page, pagina: string, landed: Locator): Promise<void> {
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await page.evaluate((p) => {
      window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "profile" } }));
      window.dispatchEvent(new CustomEvent("topics:profile-page", { detail: { pagina: p, personId: null } }));
    }, pagina);
    await expect(landed).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

/** Asks the app to open the user menu on a level, the way the bell's gear and
 *  the plan-limit notice do (`topics:open-user-menu`). Retried for the same
 *  reason as above. */
export async function requestUserMenuLevel(page: Page, level: UserMenuLevelName): Promise<Locator> {
  const panel = page.getByTestId(`${LEVEL_ROW[level]}-menu`);
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await page.evaluate((l) => {
      window.dispatchEvent(new CustomEvent("topics:open-user-menu", { detail: { level: l } }));
    }, level);
    await expect(panel).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  return panel;
}

/** Your own profile in the Profile tab, optionally with one of its panels open. */
export async function openOwnProfile(page: Page, panel?: "people" | "outside" | "privacy"): Promise<Locator> {
  const profile = page.getByTestId("self-profile");
  await requestProfilePage(page, "profile", profile);
  if (panel) {
    await page.getByTestId(`profile-${panel}-open`).click();
    await expect(page.getByTestId(`profile-${panel}-panel`)).toBeVisible({ timeout: 15_000 });
  }
  return profile;
}

/** The organisation page, which the Profile tab hosts. */
export async function openOrganizationPage(page: Page): Promise<Locator> {
  const org = page.getByTestId("settings-page-organization");
  await requestProfilePage(page, "organization", org);
  return org;
}
