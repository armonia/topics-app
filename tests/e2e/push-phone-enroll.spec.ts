/**
 * @covers PUSH-05
 *
 * Phone push, the enrolment half: user menu > Notifications > This device > "Enable on this
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
 * and the permission prompt, which follows WebKit's gesture rule): there is no
 * Apple or Mozilla endpoint here, and the fake endpoint lives under `.invalid`,
 * a TLD that never resolves, so the test server cannot deliver anything to a
 * real device. The worker registration, the settings card, the subscribe route
 * and the SQLite row are the real ones.
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/settings.fixture";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";
import { openUserMenuLevel } from "./helpers/user-menu";

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
  const CALLS_KEY = "e2e.permissionRequests";
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
  // WebKit's rule, the one the iPhone applies: a request made outside a user
  // gesture resolves "denied" with no prompt and leaves the permission at
  // "default"; only a request inside the tap shows "Allow" (granted here).
  // Every call is logged with whether a gesture was active.
  N.requestPermission = () => {
    const active = (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;
    const log = JSON.parse(sessionStorage.getItem(CALLS_KEY) ?? "[]") as boolean[];
    log.push(active);
    sessionStorage.setItem(CALLS_KEY, JSON.stringify(log));
    if (!active) return Promise.resolve("denied");
    sessionStorage.setItem(PERM_KEY, "granted");
    return Promise.resolve("granted");
  };

  // Playwright's WebKit build ships no Push API at all (the iOS home-screen app
  // does): provide the constructor and the registration's `pushManager`, then
  // fake the two calls the app makes, exactly as on an engine that has them.
  if (typeof w.PushManager === "undefined") {
    w.PushManager = class PushManager {} as unknown;
  }
  const PushManagerClass = w.PushManager as { new (): object; prototype: Record<string, unknown> };
  const RegistrationClass = w.ServiceWorkerRegistration as { prototype: object } | undefined;
  if (RegistrationClass && !("pushManager" in RegistrationClass.prototype)) {
    const shared = new PushManagerClass();
    Object.defineProperty(RegistrationClass.prototype, "pushManager", { configurable: true, get: () => shared });
  }
  PushManagerClass.prototype.subscribe = function subscribe() {
    const endpoint = `https://push.invalid/e2e/${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SUB_KEY, endpoint);
    return Promise.resolve(fakeSubscription(endpoint));
  };
  PushManagerClass.prototype.getSubscription = function getSubscription() {
    const endpoint = sessionStorage.getItem(SUB_KEY);
    return Promise.resolve(endpoint ? fakeSubscription(endpoint) : null);
  };
}

/** Every permission request so far: `true` = made inside a user gesture. */
async function permissionRequests(page: import("@playwright/test").Page): Promise<boolean[]> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("e2e.permissionRequests") ?? "[]") as boolean[]);
}

/** The push controls: the «This device» level of the user menu's Notifications
 *  level, where the Settings page's push card moved. */
async function openThisDevicePush(page: import("@playwright/test").Page): Promise<void> {
  const level = await openUserMenuLevel(page, "notifications");
  await level.getByTestId("notif-this-device").click();
  await expect(page.getByTestId("notif-this-device-menu")).toBeVisible({ timeout: 10_000 });
}

/** Is a service worker registered for this page right now? */
async function hasWorker(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
}

test.describe("Phone push: enrolment from Settings", () => {
  test("PUSH-05: the settings toggle subscribes this device on a non-localhost origin, and the worker survives a reload", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PUSH-05" });
    await page.addInitScript(stubPushService);

    await page.goto(`${PHONE_LIKE_ORIGIN}/`);
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });

    // 1. The worker exists on this origin. Before the fix `boot.js` skipped
    //    registration here and unregistered any worker it found.
    await expect.poll(() => hasWorker(page), { timeout: 15_000, message: "no service worker on a non-localhost origin" }).toBe(true);

    // 2. User menu > Notifications > This device: the level says "not
    //    subscribed" and offers the button.
    await openThisDevicePush(page);
    const headline = page.getByTestId("push-status-headline");
    await expect(headline).toContainText("Non iscritto");
    const enable = page.getByTestId("push-subscribe");
    await expect(enable).toBeEnabled();

    // 3. One tap: permission, subscription, server row. Any request made
    //    before the tap had no gesture, so it was answered "denied" and the
    //    permission is still undecided: the tap itself must ask, inside the
    //    gesture, or no "Allow" ever appears on the phone.
    const before = await permissionRequests(page);
    expect(before.every((inGesture) => !inGesture)).toBe(true);
    expect(await page.evaluate(() => Notification.permission)).toBe("default");
    await enable.click();
    await expect.poll(() => permissionRequests(page)).toEqual([...before, true]);
    await expect(headline).toContainText("Iscritto: le notifiche arrivano anche ad app chiusa");
    // Subscribed, the level carries this device's own choices: receive here,
    // and «when Topics is already open» as a segment that says which one is on.
    await expect(page.getByTestId("push-receive-here")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("push-when-open-native")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("push-when-open-in-app")).toHaveAttribute("aria-checked", "false");

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
    await openThisDevicePush(page);
    await expect(page.getByTestId("push-status-headline")).toContainText("Iscritto: le notifiche arrivano anche ad app chiusa");

    // 5. Unsubscribe from the same card: the server row goes away.
    await page.getByTestId("push-unsubscribe").click();
    await expect(page.getByTestId("push-status-headline")).toContainText("Non iscritto");
    await expect.poll(listed).toBeNull();
  });
});
