import { expect, type Locator, type Page } from "@playwright/test";
import { openProfileMenu } from "./open-perf-panel";

/**
 * THE PREFERENCES AND THE IDENTITY MOVED, and these are their new doors.
 *
 * Appearance, Notifications, View and Devices are levels of the user menu (the
 * user card on the desktop, the title menu on the phone, `openProfileMenu`
 * picks); the profile, the followers and the organisation are the Profile tab.
 * A spec asks for the level or the page, never for the row that opens it on
 * one screen only.
 */
const LEVEL_ROW = {
  appearance: "topics-menu-appearance",
  notifications: "topics-menu-notifications",
  view: "topics-menu-view",
  devices: "profile-menu-devices",
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
 * Asks for a section the way a stale link does, on the Settings event: the app
 * sends the sections that left the panel to their new home. Retried, because
 * the listener exists only once the app has mounted.
 */
export async function requestSettingsSection(page: Page, section: string, landed: Locator): Promise<void> {
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await page.evaluate((s) => {
      window.dispatchEvent(new CustomEvent("topics:open-settings", { detail: { section: s } }));
    }, section);
    await expect(landed).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

/** Your own profile in the Profile tab, optionally with one of its panels open. */
export async function openOwnProfile(page: Page, panel?: "people" | "outside" | "privacy"): Promise<Locator> {
  const profile = page.getByTestId("self-profile");
  await requestSettingsSection(page, "profile", profile);
  if (panel) {
    await page.getByTestId(`profile-${panel}-open`).click();
    await expect(page.getByTestId(`profile-${panel}-panel`)).toBeVisible({ timeout: 15_000 });
  }
  return profile;
}

/** The organisation page, which the Profile tab hosts. */
export async function openOrganizationPage(page: Page): Promise<Locator> {
  const org = page.getByTestId("settings-page-organization");
  await requestSettingsSection(page, "organization", org);
  return org;
}
