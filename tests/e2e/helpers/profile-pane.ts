import { expect, type Page } from "@playwright/test";

/**
 * Open the Profile TAB and wait for it.
 *
 * THE IDENTITY BAND IS NOT IN HERE, and this helper is not the way to it: those
 * three rows stayed at the bottom of the sidebar, on screen at all times, so
 * the specs that measure them (org-presence) open no tab at all. This helper is
 * for the specs whose subject IS the profile tab: the page itself and the two
 * dropdowns that open from it (the people, the privacy), which have nothing to
 * look at until it is open.
 *
 * Through the same bus the "+" menu and the Topics menu use, not through the
 * menu itself: what these specs are about is the identity, and driving three
 * clicks to get there would make them red for a reason that is not theirs.
 */
export async function openProfilePane(page: Page): Promise<void> {
  // The bus listeners register only after the first pane-store hydration, so
  // an event sent right after `goto` can land on nobody (seen red on WebKit,
  // base included). Re-send until the pane shows: the bus focuses an open
  // Profile tab instead of opening a second one.
  await expect(async () => {
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "profile" } })),
    );
    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
}
