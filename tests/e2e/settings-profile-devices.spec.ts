/**
 * "Who you are" and "what machines you have" are two entries, and both doors
 * actually lead there.
 *
 * The original work (6134a25e) split one single entry in two: `SectionId` said
 * `devices` while the label said "Profile". It was verified by looking at the
 * column by eye, and nothing more: no test held it in place. It is the same
 * pattern that let the presence bug (e290c513) through, where seven green tests
 * never once looked at the screen.
 *
 * What is defended here are the three things a regression would break first:
 * the two entries exist, they show DIFFERENT content, and the two deep links
 * each land on their own one. That last part is precisely what used to be
 * broken, with `onOpenDevices` and `onOpenProfile` both pointing at `devices`.
 *
 * The active entry is read from `aria-current="page"`, which the panel already
 * sets: a `data-testid` added on purpose for the test would measure the test.
 */
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";

// The boundary between this file and the previous one: without it this spec
// inherits whatever the tests before it left behind in the shared DB.
hermetic(test);

const SHOTS = "test-results/settings";

/**
 * Cmd+comma opens Preferences: the same door `escape-modal-guard` uses.
 *
 * THE WAIT BEFORE THE KEYSTROKE is not ceremony. The shortcut is listened for
 * by an effect of the mounted app, so a keypress sent to a freshly loaded
 * document falls into the void and the test turns flaky (observed: first
 * attempt red, retry green). What we wait for is a LIVE piece of the app and
 * not a fixed delay, and the key is pressed again until the panel is there:
 * that way the proof depends on the app being ready and not on how loaded the
 * machine happens to be.
 */
async function apriImpostazioni(page: Page) {
  // A LIVE piece of the app: the sidebar. It used to be the identity row,
  // which is not in the sidebar any more (card a035f945 moved it into the
  // Profile tab): waiting for it here made the wait fail for a reason that has
  // nothing to do with the panel this file is about.
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20000 });
  const pannello = page.locator('[data-testid="settings-panel"]');
  await expect(async () => {
    await page.keyboard.press("Meta+Comma");
    await expect(pannello).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  return pannello;
}

test.describe("Impostazioni: profilo e dispositivi sono due domande", () => {
  test("SETTINGS-01: Profile e Devices sono due voci distinte", async ({ page }) => {
    await page.goto("/");
    const pannello = await apriImpostazioni(page);
    await expect(pannello.getByRole("button", { name: "Profilo", exact: true })).toBeVisible();
    await expect(pannello.getByRole("button", { name: "Dispositivi", exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "settings-due-voci.png") });
  });

  test("SETTINGS-02: le due voci mostrano contenuti diversi", async ({ page }) => {
    // Two labels over the SAME panel would be the earlier flaw with one extra
    // name on it: the proof they are separate is what sits inside them.
    await page.goto("/");
    const pannello = await apriImpostazioni(page);

    await pannello.getByRole("button", { name: "Profilo", exact: true }).click();
    const profilo = await pannello.innerText();

    await pannello.getByRole("button", { name: "Dispositivi", exact: true }).click();
    const dispositivi = await pannello.innerText();

    expect(profilo).not.toBe(dispositivi);
  });

  test("SETTINGS-03: il chip dei dispositivi apre i DISPOSITIVI, non il profilo", async ({ page }) => {
    // THIS is the original bug: `onOpenDevices` (the identity row at the
    // bottom of the sidebar) and `onOpenProfile` (the Topics menu) BOTH pointed
    // at `devices`. Two different doors opening onto the same room.
    //
    // UPDATE: the identity row now has TWO doors, because it had two subjects.
    // The name and the face open your PROFILE (it is the row that talks about
    // you), the chip with the machine count opens the DEVICES. What has to be
    // defended is unchanged: the devices keep a door of their own and are not
    // swallowed by the profile.
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    // THE SHAPE IS THE ROUTE'S REAL ONE. This stub used to send a device with
    // no `id` and no `name`: the devices section takes both for granted (the
    // type says `id: string`), so opening it crashed the WHOLE app — a white
    // screen, outside every error boundary — and the red accused the devices
    // door of not opening. The comparison defect behind the crash is closed in
    // the component; here we remove the cause, which is a fake server poorer
    // than the real one. Same lesson as the person stub above.
    await page.route("**/api/auth/devices", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ devices: [{
          id: "dev-1", name: "Questo computer", createdAt: 1, lastSeenAt: 2,
          firstIp: null, revokedAt: null, connected: true, current: true,
          role: "owner", person: null,
        }] }) }));
    await page.goto("/");

    // The devices have moved INSIDE the identity panel: on the row they were a
    // "1/1" next to an icon, which is to say the bit that had to be explained
    // every single time. The door is the same one though, and it stays separate
    // from the profile.
    await page.getByTestId("identity-me-profile").click();
    const ferri = page.getByTestId("identity-me-devices");
    await expect(ferri).toBeVisible({ timeout: 20000 });
    await ferri.click();

    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 20000 });
    await expect(
      pannello.getByRole("button", { name: "Dispositivi", exact: true }),
      "il chip dei ferri deve aprire i DISPOSITIVI",
    ).toHaveAttribute("aria-current", "page");
    await expect(
      pannello.getByRole("button", { name: "Profilo", exact: true }),
      "…e NON il profilo: sono due domande diverse, e ognuna ha la sua porta",
    ).not.toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: join(SHOTS, "settings-deeplink-devices.png") });
  });

  test("SETTINGS-04: dalla riga d'identità si arriva al pane Profilo", async ({ page }) => {
    // The other half of the same decision: the row talks about you, so it leads
    // where you go to look at who you are. Before, nothing led there at all,
    // and the profile could only be found from the "Topics" menu.
    //
    // THE PATH IS ONE CLICK LONGER THAN IT WAS, on purpose. The row used to
    // jump straight to the pane; now it opens its own panel, which answers the
    // small questions on the spot and keeps the door to the page at its foot
    // (the rule is written in the identity block: every chip opens its panel).
    // This test follows the door where it went — it does not ask the row to go
    // back to being a shortcut.
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    await page.goto("/");

    const io = page.getByTestId("identity-me-profile");
    await expect(io).toBeVisible({ timeout: 20000 });
    await io.click();

    const porta = page.getByTestId("identity-me-open-profile");
    await expect(porta).toBeVisible({ timeout: 20000 });
    await porta.click();

    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    // AND on the right page: the pane has three, and a door that opens it on
    // somebody else's tab is a door that lands next to where you asked.
    await expect(page.getByTestId("settings-page-profile")).toBeVisible();
  });
});
