import { test, expect } from "@playwright/test";

// Specs from openspec/changes/add-master-topic-mode/specs/notifications/spec.md
// Gherkin: tests/features/notifications-*.feature
//
// Gated with `test.fixme` until Phase F lands.

test.describe("NOTIF-01 — Triple-layer event capture", () => {
  test.fixme(
    "Real-time Darwin notification arrives within 500ms",
    async ({ page }) => {
      await page.goto("/");
      // Spec: tray badge increments within 500ms of session emitting Stop
    },
  );

  test.fixme(
    "FS watcher backup catches missed Darwin notif",
    async ({ page }) => {
      await page.goto("/");
    },
  );

  test.fixme("Polling fallback closes any remaining gap", async ({ page }) => {
    await page.goto("/");
  });

  test.fixme(
    "Routine tool_use events do not notify (NOTIF-05)",
    async ({ page }) => {
      await page.goto("/");
      // 50 tool_use events → zero notifications → badge unchanged
    },
  );
});

test.describe("NOTIF-02 — Severity routing", () => {
  test.fixme("P0 → sound + desktop + iOS push", async ({ page }) => {
    await page.goto("/");
  });

  test.fixme("P1 → silent desktop + badge", async ({ page }) => {
    await page.goto("/");
  });

  test.fixme("P2 → badge only", async ({ page }) => {
    await page.goto("/");
  });
});

test.describe("NOTIF-03 — Focus mode awareness", () => {
  test.fixme(
    "Focus mode suppresses P1 but always delivers P0",
    async ({ page }) => {
      await page.goto("/");
    },
  );
});

test.describe("NOTIF-04 — Click routes to context", () => {
  test.fixme(
    "Click on awaiting-review notification focuses pane",
    async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("reasoning-trail")).toBeVisible();
    },
  );
});
