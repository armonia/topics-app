/**
 * @covers PUSH-05
 *
 * Phone push, the enrolment half: Settings > Notifications > "Enable on this
 * device" leaves a subscription on the server, on an address that is NOT
 * `localhost`, and the service worker that carries it survives a reload.
 *
 * Why an address other than `localhost`: the phone never reaches Topics as
 * `localhost` (it uses the LAN name, the Tailscale address or the relay host),
 * and `boot.js` used to register the worker ONLY on `localhost` and
 * `*.trycloudflare.com`, unregistering it everywhere else at every load. So on
 * the phone no worker ever existed, `navigator.serviceWorker.ready` never
 * settled and `push_subscriptions` stayed at 0 rows. `127.0.0.1` is a secure
 * context like the phone's HTTPS origin and is not `localhost`: the smallest
 * address that reproduces the phone's branch of `boot.js`.
 *
 * Only the push SERVICE is faked (`PushManager.subscribe` / `getSubscription`
 * and the permission prompt): there is no Apple or Mozilla endpoint here, and
 * the fake endpoint lives under `.invalid`, a TLD that never resolves, so the
 * test server cannot deliver anything to a real device. The worker
 * registration, the settings card, the subscribe route and the SQLite row are
 * the real ones.
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/settings.fixture";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** The phone-like origin: same server, reached by an address that is not `localhost`. */
const PHONE_LIKE_ORIGIN = E2E_BASE.replace("//localhost:", "//127.0.0.1:");

/**
 * Runs before any page script. Stands in for the push service and the OS
 * permission prompt, nothing else. State lives in `sessionStorage` so it
 * survives the reload the test performs, like a real subscription would.
 */
function stubPushService(): void {
  const SUB_KEY = "e2e.fakePushEndpoint";
  const PERM_KEY = "e2e.fakeNotificationPermission";
  // A syntactically valid P-256 public key and auth secret: the server stores
  // them, it never uses them in this test.
  const keys = {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  };
  const fakeSubscription = (endpoint: string) => ({
    endpoint,
    expirationTime: null,
    toJSON: () => ({ endpoint, expirationTime: null, keys }),
    unsubscribe: () => {
      sessionStorage.removeItem(SUB_KEY);
      return Promise.resolve(true);
    },
  });

  const w = window as unknown as Record<string, unknown>;
  if (typeof w.Notification === "undefined") {
    w.Notification = function Notification() {} as unknown;
  }
  const N = w.Notification as { permission?: string; requestPermission?: () => Promise<string> };
  Object.defineProperty(N, "permission", {
    configurable: true,
    get: () => sessionStorage.getItem(PERM_KEY) ?? "default",
  });
  N.requestPermission = () => {
    sessionStorage.setItem(PERM_KEY, "granted");
    return Promise.resolve("granted");
  };

  // Playwright's WebKit build ships no Push API at all (the iOS home-screen app
  // does): provide the constructor and the registration's `pushManager`, then
  // fake the two calls the app makes, exactly as on an engine that has them.
  if (typeof w.PushManager === "undefined") {
    w.PushManager = class PushManager {} as unknown;
  }
  const PM = w.PushManager as { new (): object; prototype: Record<string, unknown> };
  const SWR = w.ServiceWorkerRegistration as { prototype: object } | undefined;
  if (SWR && !("pushManager" in SWR.prototype)) {
    const shared = new PM();
    Object.defineProperty(SWR.prototype, "pushManager", { configurable: true, get: () => shared });
  }
  PM.prototype.subscribe = function subscribe() {
    const endpoint = `https://push.invalid/e2e/${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SUB_KEY, endpoint);
    return Promise.resolve(fakeSubscription(endpoint));
  };
  PM.prototype.getSubscription = function getSubscription() {
    const endpoint = sessionStorage.getItem(SUB_KEY);
    return Promise.resolve(endpoint ? fakeSubscription(endpoint) : null);
  };
}

/** Is a service worker registered for this page right now? */
async function hasWorker(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
}

test.describe("Phone push: enrolment from Settings", () => {
  test("PUSH-05: the settings toggle subscribes this device on a non-localhost origin, and the worker survives a reload", async ({
    page,
    settingsPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PUSH-05" });
    await page.addInitScript(stubPushService);

    await page.goto(`${PHONE_LIKE_ORIGIN}/`);
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    // 1. The worker exists on this origin. Before the fix `boot.js` skipped
    //    registration here and unregistered any worker it found.
    await expect.poll(() => hasWorker(page), { timeout: 15_000, message: "no service worker on a non-localhost origin" }).toBe(true);

    // 2. Settings > Notifications: the card says "not subscribed" and offers the button.
    await settingsPage.openSettings();
    await settingsPage.panel.getByRole("button", { name: /^(Notifications|Notifiche)$/ }).click();
    const headline = page.getByTestId("push-status-headline");
    await expect(headline).toContainText("Non iscritto");
    const enable = page.getByTestId("push-subscribe");
    await expect(enable).toBeEnabled();

    // 3. One tap: permission, subscription, server row.
    await enable.click();
    await expect(headline).toContainText("Iscritto: le notifiche arrivano anche ad app chiusa");

    const deviceId = await page.evaluate(() => localStorage.getItem("topics.push.deviceId"));
    expect(deviceId).toBeTruthy();
    const listed = async () => {
      const res = await request.get(`${E2E_BASE}/api/push/devices?deviceId=${encodeURIComponent(deviceId!)}`);
      const body = (await res.json()) as { devices: { deviceId: string; isThisDevice: boolean; enabled: boolean }[] };
      return body.devices.find((d) => d.deviceId === deviceId) ?? null;
    };
    await expect.poll(async () => (await listed())?.isThisDevice ?? false).toBe(true);
    expect((await listed())?.enabled).toBe(true);

    // 4. Reload: the worker that carries the subscription is still registered,
    //    and the card still says subscribed. The old `boot.js` unregistered it
    //    here, which on a real phone also drops the push subscription.
    //    `boot.js` decides on `load`, so the check waits for its verdict (the
    //    "SW registered:" line) instead of racing it.
    const bootVerdict = page.waitForEvent("console", {
      predicate: (m) => m.text().startsWith("SW registered:"),
      timeout: 20_000,
    });
    await page.reload();
    await bootVerdict;
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
    expect(await hasWorker(page)).toBe(true);
    await settingsPage.openSettings();
    await settingsPage.panel.getByRole("button", { name: /^(Notifications|Notifiche)$/ }).click();
    await expect(page.getByTestId("push-status-headline")).toContainText("Iscritto: le notifiche arrivano anche ad app chiusa");

    // 5. Unsubscribe from the same card: the server row goes away.
    await page.getByTestId("push-unsubscribe").click();
    await expect(page.getByTestId("push-status-headline")).toContainText("Non iscritto");
    await expect.poll(listed).toBeNull();
  });
});
