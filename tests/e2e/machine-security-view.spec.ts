/**
 * MACHINE-06: every machine row in Devices shows its security shield beside the
 * name and lists the four checks in its own menu. The health round is stubbed
 * (`/api/machines/health`); `SECURITY_SHOT_DIR` saves the open level at the
 * four widths the review asks for.
 *
 * Mutation: with the route answering an empty round the Mac shield is
 * `unknown`, never green; dropping the stub makes the `warn` assertion red.
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";

hermetic(test);
test.use({ video: "on" });

const NOW = Math.floor(Date.now() / 1000);
const node = (id: string, name: string) => ({
  id, name, hostname: `${id}:1`, arch: "", platform: "", daemonVersion: "0.0.0",
  status: "online", lastHeartbeatAt: new Date().toISOString(), lastSeenAt: "", acknowledgedWarnings: {},
  baseUrl: `https://${id}.invalid`, slots: null, createdAt: "", updatedAt: "",
});
const entry = (id: string, name: string, kind: "local" | "remote", status: string, checkedAt: number | null, checks: unknown[]) => ({
  id, name, kind, security: { checked_at: checkedAt, status, checks },
  history: { step_s: 300, from: 0, cpu: [], mem: [] }, cards_today: [],
});
const FOUR = (updates: string, status: string) => [
  { key: "updates", status, detail: updates },
  { key: "disk", status: "ok", detail: "Disk encrypted" },
  { key: "access", status: "ok", detail: "No port open to the internet" },
  { key: "antivirus", status: "info", detail: "Not needed on this system" },
];

async function openDevices(page: Page) {
  await goToApp(page);
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await page.getByTestId("profile-menu").getByTestId("profile-menu-devices").click();
  const level = page.getByTestId("profile-menu-devices-menu");
  await expect(level).toBeVisible({ timeout: 10_000 });
  return level;
}

test("each machine row carries its shield and the four checks", async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "MACHINE-06" });
  await page.route("**/api/machines", (r) => r.fulfill({ json: { machines: [node("node-a", "Node A"), node("node-b", "Node B")] } }));
  await page.route("**/api/machines/health", (r) => r.fulfill({
    json: {
      at: NOW,
      machines: [
        entry("local-1", "This computer", "local", "warn", NOW - 120, FOUR("1 update waiting for 11 days", "warn")),
        entry("node-a", "Node A", "remote", "ok", NOW - 7200, FOUR("Up to date", "ok")),
      ],
    },
  }));
  const level = await openDevices(page);

  await expect(level.getByTestId("device-row").getByTestId("machine-security-mark")).toHaveAttribute("data-status", "warn");
  const rowA = level.locator('[data-testid="device-node-row"]').first();
  await expect(rowA.getByTestId("machine-security-mark")).toHaveAttribute("data-status", "ok");
  // A measurement older than an hour shows its age beside the shield.
  await expect(rowA.getByTestId("machine-security-age")).toBeVisible();
  // A machine never measured is `unknown`, never green.
  await expect(level.locator('[data-testid="device-node-row"]').nth(1).getByTestId("machine-security-mark")).toHaveAttribute("data-status", "unknown");

  await level.getByTestId("device-row").getByTestId("machine-security-mark").click();
  const checks = level.getByTestId("machine-security-check");
  await expect(checks).toHaveCount(4);
  await expect(checks.first()).toContainText("1 update waiting for 11 days");

  const dir = process.env.SECURITY_SHOT_DIR;
  if (dir) {
    for (const width of [375, 768, 1440, 3440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/security-${width}.png` });
    }
  }
});
