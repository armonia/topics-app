import { expect } from "@playwright/test";
import { test } from "./fixtures/settings.fixture";
import { goToApp } from "./helpers";

test.describe("Push Notifications (CMD-02)", () => {
  test("CMD-02-01: unsupported browser shows no push UI", async ({ page, settingsPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-02" });

    // Remove PushManager and serviceWorker from browser context
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "serviceWorker", { value: undefined, writable: false });
      // @ts-ignore
      delete window.PushManager;
    });

    await settingsPage.mockUiStateEndpoints();
    await goToApp(page);
    await settingsPage.openSettings();

    // When unsupported, PushNotificationsToggle returns null — no "Push Notifications" label
    await expect(settingsPage.panel).toBeVisible();
    const pushLabel = settingsPage.panel.locator("label", { hasText: "Push Notifications" });
    await expect(pushLabel).toHaveCount(0);
  });

  test("CMD-02-02: denied permission shows blocked message", async ({ page, settingsPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-02" });

    // Simulate push support but denied permission
    await page.addInitScript(() => {
      // Ensure serviceWorker and PushManager exist
      if (!("serviceWorker" in navigator)) {
        const mockReg = {
          pushManager: {
            getSubscription: () => Promise.resolve(null),
            subscribe: () => Promise.reject(new Error("denied")),
          },
        };
        Object.defineProperty(navigator, "serviceWorker", {
          value: { ready: Promise.resolve(mockReg), register: () => Promise.resolve(mockReg) },
          writable: false,
        });
      }
      if (!window.PushManager) {
        (window as any).PushManager = class {};
      }
      // Override Notification.permission to "denied"
      Object.defineProperty(window, "Notification", {
        value: { permission: "denied", requestPermission: () => Promise.resolve("denied") },
        writable: false,
      });
    });

    await settingsPage.mockUiStateEndpoints();
    await goToApp(page);
    await settingsPage.openSettings();

    // Verify "Push Notifications" label is visible
    const pushLabel = settingsPage.panel.locator("label", { hasText: "Push Notifications" });
    await expect(pushLabel).toBeVisible({ timeout: 5_000 });

    // Verify blocked message is shown
    await expect(settingsPage.panel.locator("text=blocked by your browser")).toBeVisible();
  });

  test("CMD-02-03: subscribe flow fetches VAPID key and registers", async ({ page, settingsPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-02" });

    let vapidFetched = false;
    let subscribeCalled = false;

    // Mock push support with "default" permission (not yet granted)
    await page.addInitScript(() => {
      const mockSub = {
        endpoint: "https://example.com/push/abc",
        toJSON: () => ({ endpoint: "https://example.com/push/abc", keys: { p256dh: "key1", auth: "key2" } }),
        unsubscribe: () => Promise.resolve(true),
      };
      const mockReg = {
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => Promise.resolve(mockSub),
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { ready: Promise.resolve(mockReg), register: () => Promise.resolve(mockReg) },
        writable: false,
        configurable: true,
      });
      if (!window.PushManager) {
        (window as any).PushManager = class {};
      }
      Object.defineProperty(window, "Notification", {
        value: {
          permission: "default",
          requestPermission: () => {
            // Simulate granting permission
            Object.defineProperty(window.Notification, "permission", { value: "granted", writable: true });
            return Promise.resolve("granted" as NotificationPermission);
          },
        },
        writable: false,
        configurable: true,
      });
    });

    // Mock VAPID and subscribe endpoints
    await page.route("**/api/push/vapid-public-key", async (route) => {
      vapidFetched = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ publicKey: "BNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3MNq5MNq3" }),
      });
    });
    await page.route("**/api/push/subscribe", async (route) => {
      subscribeCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await settingsPage.mockUiStateEndpoints();
    await goToApp(page);
    await settingsPage.openSettings();

    // Find and click the "Enable push notifications" button
    const enableBtn = settingsPage.panel.locator("button", { hasText: "Enable push notifications" });
    await expect(enableBtn).toBeVisible({ timeout: 5_000 });
    await enableBtn.click();

    // Wait for the button text to change to "Disable" (indicating subscription succeeded)
    await expect(
      settingsPage.panel.locator("button", { hasText: "Disable push notifications" })
    ).toBeVisible({ timeout: 10_000 });

    // Verify API calls were made
    expect(vapidFetched).toBe(true);
    expect(subscribeCalled).toBe(true);
  });

  test("CMD-02-04: unsubscribe flow sends unsubscribe request", async ({ page, settingsPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-02" });

    let unsubscribeCalled = false;

    // Mock as already subscribed
    await page.addInitScript(() => {
      const mockSub = {
        endpoint: "https://example.com/push/existing",
        toJSON: () => ({ endpoint: "https://example.com/push/existing", keys: { p256dh: "key1", auth: "key2" } }),
        unsubscribe: () => Promise.resolve(true),
      };
      const mockReg = {
        pushManager: {
          getSubscription: () => Promise.resolve(mockSub),
          subscribe: () => Promise.resolve(mockSub),
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { ready: Promise.resolve(mockReg), register: () => Promise.resolve(mockReg) },
        writable: false,
        configurable: true,
      });
      if (!window.PushManager) {
        (window as any).PushManager = class {};
      }
      Object.defineProperty(window, "Notification", {
        value: { permission: "granted", requestPermission: () => Promise.resolve("granted" as NotificationPermission) },
        writable: false,
        configurable: true,
      });
    });

    // Mock unsubscribe endpoint
    await page.route("**/api/push/unsubscribe", async (route) => {
      unsubscribeCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await settingsPage.mockUiStateEndpoints();
    await goToApp(page);
    await settingsPage.openSettings();

    // Should show "Disable push notifications" since already subscribed
    const disableBtn = settingsPage.panel.locator("button", { hasText: "Disable push notifications" });
    await expect(disableBtn).toBeVisible({ timeout: 5_000 });
    await disableBtn.click();

    // Wait for state to change back to "Enable"
    await expect(
      settingsPage.panel.locator("button", { hasText: "Enable push notifications" })
    ).toBeVisible({ timeout: 10_000 });

    expect(unsubscribeCalled).toBe(true);
  });

  test("CMD-02-05: subscribe error is handled gracefully", async ({ page, settingsPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-02" });

    // Mock push support with default permission
    await page.addInitScript(() => {
      const mockReg = {
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => Promise.reject(new Error("Subscribe failed")),
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { ready: Promise.resolve(mockReg), register: () => Promise.resolve(mockReg) },
        writable: false,
        configurable: true,
      });
      if (!window.PushManager) {
        (window as any).PushManager = class {};
      }
      Object.defineProperty(window, "Notification", {
        value: {
          permission: "default",
          requestPermission: () => {
            Object.defineProperty(window.Notification, "permission", { value: "granted", writable: true });
            return Promise.resolve("granted" as NotificationPermission);
          },
        },
        writable: false,
        configurable: true,
      });
    });

    // Mock VAPID endpoint to return 500
    await page.route("**/api/push/vapid-public-key", async (route) => {
      await route.fulfill({ status: 500, body: "Internal Server Error" });
    });

    await settingsPage.mockUiStateEndpoints();
    await goToApp(page);
    await settingsPage.openSettings();

    // Click enable — should fail gracefully
    const enableBtn = settingsPage.panel.locator("button", { hasText: "Enable push notifications" });
    await expect(enableBtn).toBeVisible({ timeout: 5_000 });
    await enableBtn.click();

    // Wait a moment for async to complete, then verify button is still "Enable" (not "Disable")
    // The loading state ("...") should resolve back to enable
    await expect(enableBtn).toBeVisible({ timeout: 10_000 });

    // Settings panel should still be functional (no crash)
    await expect(settingsPage.panel).toBeVisible();
  });
});
