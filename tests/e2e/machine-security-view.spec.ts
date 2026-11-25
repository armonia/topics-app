/**
 * MACHINE-09: every machine row in Devices shows its security shield beside the
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
import { openUserMenuLevel } from "./helpers/user-menu";

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
// The server sends codes and parameters: the client words them in the active language.
const FOUR = (updates: unknown, status: string) => [
  { key: "updates", status, detail: "Italian text the tray reads", msgs: [updates] },
  { key: "disk", status: "ok", detail: "-", msgs: [{ code: "disk.fileVaultOn" }] },
  { key: "access", status: "ok", detail: "-", msgs: [{ code: "access.sshKeyOnly" }, { code: "access.noPorts" }] },
  { key: "antivirus", status: "info", detail: "-", msgs: [{ code: "antivirus.xprotect", params: { version: "5", date: "01/01" } }] },
];

async function openDevices(page: Page) {
  await page.goto("/");
  // On a phone the sidebar is a sheet that starts closed after every load: open it,
  // then let the shared helper pick the menu's door for this width.
  const sidebar = page.locator('[aria-label="Topics sidebar"]');
  await sidebar.waitFor({ state: "attached", timeout: 15_000 });
  if (!(await sidebar.isVisible())) await page.keyboard.press("ControlOrMeta+b");
  return openUserMenuLevel(page, "devices");
}

test("each machine row carries its shield and the four checks", async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "MACHINE-09" });
  await page.route("**/api/machines", (r) => r.fulfill({ json: { machines: [node("node-a", "Node A"), node("node-b", "Node B")] } }));
  await page.route("**/api/machines/health", (r) => r.fulfill({
    json: {
      at: NOW,
      machines: [
        entry("local-1", "This computer", "local", "warn", NOW - 120, FOUR({ code: "updates.pendingSince", params: { n: 1, days: 11 } }, "warn")),
        entry("node-a", "Node A", "remote", "ok", NOW - 7200, FOUR({ code: "updates.none" }, "ok")),
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
  await expect(checks.first()).toContainText(/1 security update waiting for 11 days|1 aggiornamento di sicurezza in attesa da 11 giorni/);
  // The mark names the machine, so two rows never read the same.
  await expect(level.getByTestId("device-row").getByTestId("machine-security-mark")).toHaveAttribute("aria-label", /This computer|Questo computer/);

  // Resizing closes the menu, so every width opens the level and the checks again before the shot.
  const dir = process.env.SECURITY_SHOT_DIR;
  if (dir) {
    for (const width of [375, 768, 1440, 3440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      const open = await openDevices(page);
      await open.getByTestId("device-row").getByTestId("machine-security-mark").click();
      await expect(open.getByTestId("machine-security-check")).toHaveCount(4);
      await page.screenshot({ path: `${dir}/security-devices-${width}.png` });
      await page.keyboard.press("Escape");

      const panel = await openUserMenuLevel(page, "nodes");
      await expect(panel.getByTestId("node-row-node-a").getByTestId("machine-security-mark")).toBeVisible();
      await panel.getByTestId("node-row-node-a").getByTestId("machine-security-mark").click();
      await expect(panel.getByTestId("machine-security-check")).toHaveCount(4);
      await page.screenshot({ path: `${dir}/security-machines-${width}.png` });
    }
  }
});

test("the cloud node gets no shield, and the slots field names its node", async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "MACHINE-09" });
  const cloud = { ...node("cloud-1", "Cloud"), baseUrl: "claude-cloud://" };
  await page.route("**/api/machines", (r) => r.fulfill({ json: { machines: [node("node-a", "Node A"), cloud] } }));
  await page.route("**/api/machines/health", (r) => r.fulfill({ json: { at: NOW, machines: [] } }));
  await goToApp(page);
  const panel = await openUserMenuLevel(page, "nodes");
  await expect(panel.getByTestId("node-row-node-a").getByTestId("machine-security-mark")).toHaveAttribute("data-status", "unknown");
  await expect(panel.getByTestId("node-row-cloud-1")).toBeVisible();
  await expect(panel.getByTestId("node-row-cloud-1").getByTestId("machine-security-mark")).toHaveCount(0);
  await expect(panel.getByRole("spinbutton", { name: /Node A/ })).toBeVisible();
  await expect(panel.getByRole("spinbutton", { name: /Cloud/ })).toBeVisible();
});
