import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { openProfileMenu } from "./helpers/open-perf-panel";

hermetic(test);

/**
 * API-DOOR on the WEB: every `/api` call of the client goes through `apiFetch`
 * (client/src/lib/shell/net.ts), and on a plain browser page, where the Tauri
 * shim is absent by design (NETSHIM-01), the door is the only thing between a
 * callsite and the server.
 *
 * What the door adds there is the identity refusal: a 401 from the server's
 * identity gate turns into the pairing screen, whichever call met it. Before the
 * door only `api.ts::request` looked, so a call written as a raw `fetch` (the
 * version chip's `/api/version`, the pane-store sync, the tombstones...) failed
 * in silence. This spec uses the version chip's read because a person triggers
 * it with one gesture, after the app has already decided who is in.
 */
test.describe("api door (web)", () => {
  test("a refusal met by a former raw fetch opens the pairing screen", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "NETSHIM-01" });
    await goToApp(page);

    // NETSHIM-01: no wrapper on the page's fetch outside the native shell.
    const nativeFetch = await page.evaluate(() =>
      Function.prototype.toString.call(window.fetch).includes("[native code]"),
    );
    expect(nativeFetch).toBe(true);

    // The app is in: the sidebar is there and no pairing screen is.
    await expect(page.getByText(/Access revoked|Accesso revocato/)).toHaveCount(0);

    let refused = 0;
    await page.route("**/api/version", async (route) => {
      refused++;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "device revoked", code: "device_revoked" }),
      });
    });

    // Opening the profile menu mounts the system menu, whose effect reads
    // `/api/version`: the call that used to be a raw fetch.
    await openProfileMenu(page).catch(() => {
      // The menu may already be gone behind the pairing screen: the assertion
      // below is the verdict, not this gesture.
    });

    await expect.poll(() => refused, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByText(/Access revoked|Accesso revocato/).first()).toBeVisible({ timeout: 15_000 });
  });
});
