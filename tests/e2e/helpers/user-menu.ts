import { expect, type Locator, type Page } from "@playwright/test";
import { openProfileMenu } from "./open-perf-panel";

/**
 * EVERY SETTING HAS ONE HOME, and these are its doors.
 *
 * The user menu keeps who you are and how the app looks: Plan, Devices (with
 * the Machines section inside), Appearance, Notifications, View (the user card
 * on the desktop, the title menu on the phone: `openProfileMenu` picks). The
 * other forms live where they are used and one host draws them
 * (`openHomePanel`): AI providers beside the model selector, MCP tools beside
 * the composer's «+», the calendar beside its tile (SETHOME-01). The profile,
 * the followers and the organisation are the Profile tab. A spec asks for the
 * level, the panel or the page, never for the row that opens it on one screen
 * only.
 */
const LEVEL_ROW = {
  plan: "topics-menu-plan",
  devices: "profile-menu-devices",
  /** The Machines section, a level inside Devices. */
  nodes: "devices-machines",
  appearance: "topics-menu-appearance",
  notifications: "topics-menu-notifications",
  view: "topics-menu-view",
} as const;

export type UserMenuLevelName = keyof typeof LEVEL_ROW;

/** Opens the user menu and one of its levels; hands back the level's panel. */
export async function openUserMenuLevel(page: Page, level: UserMenuLevelName): Promise<Locator> {
  await openProfileMenu(page);
  // The Machines section is a level of Devices: Devices opens first.
  if (level === "nodes") {
    const devices = page.getByTestId(LEVEL_ROW.devices);
    await expect(devices).toBeVisible({ timeout: 15_000 });
    await devices.click();
    await expect(page.getByTestId(`${LEVEL_ROW.devices}-menu`)).toBeVisible({ timeout: 15_000 });
  }
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

/** The forms that live where they are used, drawn by `HomePanelHost`. */
export type HomePanelName = "providers" | "tools" | "calendar";

/**
 * Opens one of those forms the way a door with no anchor of its own does (the
 * palette's command, `topics:open-home`): beside its home when the home is on
 * screen, a centred sheet when it is not, a bottom sheet on the phone. Retried,
 * because the host listens only once the app has mounted. Hands back the panel.
 * The real doors (the selector's footer, the «+», the tile's menu) have specs
 * of their own (`settings-homes.spec.ts`).
 *
 * Providers and keys is a level of the model selector (model selector
 * revision 2026-10-04, §5.1): with a model chip on screen it opens inside that
 * chip's selector, with none as a centred sheet. Either way the levels are
 * `ai-providers-settings`, and that is what comes back.
 */
export async function openHomePanel(page: Page, home: HomePanelName): Promise<Locator> {
  const panel = home === "providers" ? page.getByTestId("ai-providers-settings") : page.getByTestId(`home-panel-${home}`);
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    if (await panel.isVisible()) return;
    await page.evaluate((h) => {
      window.dispatchEvent(new CustomEvent("topics:open-home", { detail: { home: h } }));
    }, home);
    await expect(panel).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  return panel;
}
