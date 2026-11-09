/**
 * MACHINE-04: the PC and the Hetzner server among the devices, as the hub
 * sees them. The hub is stubbed (`/api/hub/machines`, `/api/hub/hetzner/spegni`)
 * so the run never touches the real hub nor Hetzner. `HUB_MACHINES_FILE` swaps
 * the stub for a saved hub answer, and `HUB_SHOT` saves the open level as a
 * PNG: that is how the proof screenshot is taken without a real browser window.
 */
import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";

hermetic(test);

const fixture = [
  { id: "local", name: "Mac", local: true, on: true, state: "tranquillo", level: 0 },
  { id: "pc", name: "PC", local: false, on: false, state: "dorme", level: 0, caption: "si sveglia da sola con offload" },
  { id: "hetzner", name: "Server Hetzner", local: false, on: true, kind: "cloud", state: "1 acceso", level: 0,
    caption: "si cancella dopo 20 min senza lavoro, al più 3 h", lines: ["cx43 acceso da 12 min · 0,03 €/h"],
    spend: { eur: 3.83, cap: 20, warn: 15, over: false },
    actions: [{ id: "spegni", label: "Spegni tutti", method: "POST", url: "/api/hetzner/spegni", confirm: "Cancellare il server acceso? Un lavoro in corso si interrompe." }] },
];

async function openDevices(page: Page) {
  await goToApp(page);
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByTestId("profile-menu-devices").click();
  const level = page.getByTestId("profile-menu-devices-menu");
  await expect(level).toBeVisible({ timeout: 10_000 });
  return level;
}

test("il PC e il server Hetzner stanno tra i dispositivi, e «Spegni tutti» chiede prima", async ({ page }) => {
  const body = process.env.HUB_MACHINES_FILE ? fs.readFileSync(process.env.HUB_MACHINES_FILE, "utf8") : JSON.stringify(fixture);
  let posts = 0;
  await page.route("**/api/hub/machines", (r) => r.fulfill({ status: 200, contentType: "application/json", body }));
  await page.route("**/api/hub/hetzner/spegni", (r) => { posts++; return r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"spenti":["offload-1"]}' }); });
  const level = await openDevices(page);
  const rows = level.getByTestId("hub-machine-row");
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  if (process.env.HUB_SHOT) await level.screenshot({ path: process.env.HUB_SHOT });
  if (process.env.HUB_MACHINES_FILE) return;

  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("PC");
  await expect(rows.nth(1)).toContainText("3,83 € su 20 € questo mese");
  // the first press only asks
  await rows.nth(1).getByTestId("hub-machine-action").click();
  await expect(level.getByTestId("hub-machine-confirm-text")).toContainText("Cancellare il server acceso?");
  expect(posts).toBe(0);
  await level.getByTestId("hub-machine-cancel").click();
  expect(posts).toBe(0);
  await rows.nth(1).getByTestId("hub-machine-action").click();
  await level.getByTestId("hub-machine-confirm").click();
  await expect.poll(() => posts).toBe(1);
});

test("un hub che non risponde non lascia righe né errori", async ({ page }) => {
  await page.route("**/api/hub/machines", (r) => r.fulfill({ status: 502, contentType: "application/json", body: '{"error":"hub not reachable"}' }));
  const level = await openDevices(page);
  await expect(level.getByTestId("device-row").first()).toBeVisible();
  if (process.env.HUB_SHOT_BEFORE) await level.screenshot({ path: process.env.HUB_SHOT_BEFORE });
  await expect(level.getByTestId("hub-machine-row")).toHaveCount(0);
  await expect(level.getByTestId("hub-machine-error")).toHaveCount(0);
});
