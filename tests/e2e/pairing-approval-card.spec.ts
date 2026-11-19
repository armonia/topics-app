/**
 * pairing-approval-card.spec.ts - what the approval card SAYS when a server asks
 * for this node's channel (card a237b001).
 *
 * The cure has a visible half: a request that declares a machine id and an epoch
 * is not a phone asking for a device slot, it is a server asking to become this
 * node's primary. The card now says that in plain words, with the epoch and who
 * loses the channel, so approving is an informed act.
 *
 * The "before" state is the SAME request drawn without those fields: until the
 * cure the card had no notion of a machine id and ignored them, so a takeover
 * looked exactly like a phone knocking. The two shots at 375 and 1440 px are
 * the before/after the eye judges.
 * @covers MACHINE-01
 */
import { test, expect } from "./fixtures/test-fixtures";
import type { Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync } from "fs";
import { homedir } from "os";

hermetic(test);

const SHOTS = `${homedir()}/.topics/media/pairing-card`;

/** A node pairing request, shaped as the WebSocket hands it to the card. */
const TAKEOVER_REQUEST = {
  id: "pair-req-node",
  code: "4F2K9A",
  name: "Topics server",
  ip: "203.0.113.7",
  from: "internet",
  machineId: "node-b7f1",
  machineEpoch: 50,
  currentPrimaryMachineId: "node-a3c0",
};

/** The same request as the card drew it before the cure: machine fields unknown. */
const { machineId: _m, machineEpoch: _e, currentPrimaryMachineId: _c, ...LEGACY_REQUEST } = TAKEOVER_REQUEST;

async function showRequest(page: Page, detail: Record<string, unknown>) {
  await page.route("**/api/auth/pair/pending", (route) => route.fulfill({ json: { requests: [] } }));
  await goToApp(page);
  const card = page.getByTestId("pair-request-card");
  // The card is a LAZY chunk: its listener exists only once that chunk has
  // loaded, so a single dispatch right after the app paints is a coin toss.
  // Re-announcing the same request is free - the card keys on its id.
  await expect(async () => {
    await page.evaluate((payload) => {
      window.dispatchEvent(new CustomEvent("topics:auth-pair-requested", { detail: payload }));
    }, detail);
    await expect(card).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return card;
}

for (const [width, height] of [[375, 812], [1440, 900]] as const) {
  test(`before the cure the same takeover looks like a device knocking, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const card = await showRequest(page, LEGACY_REQUEST);
    // Nothing on the card says a channel is changing hands: that IS the defect.
    await expect(card).not.toContainText(/epoc[ah] 50/i);
    await expect(card).not.toContainText("node-a3c0");
    await expect(card.getByTestId("pair-approve-owner")).toBeEnabled();
    mkdirSync(SHOTS, { recursive: true });
    // The whole viewport, not the card alone: the card is a fixed 320px, so a
    // crop would look the same at every width and prove nothing about how it
    // sits on a phone against a desktop.
    await page.screenshot({ path: `${SHOTS}/before-${width}.png` });
    await card.screenshot({ path: `${SHOTS}/before-card-${width}.png` });
  });

  test(`the card names the epoch and who loses the channel, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const card = await showRequest(page, TAKEOVER_REQUEST);
    // Epoch and the machine being replaced, in words, before any click.
    await expect(card).toContainText(/epoc[ah] 50/i);
    await expect(card).toContainText("node-a3c0");
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/after-${width}.png` });
    await card.screenshot({ path: `${SHOTS}/after-card-${width}.png` });
    // A wider frame around the card, for the board's own preview: the card is
    // taller than it is wide, and a board thumbnail crops the bottom off.
    const box = await card.boundingBox();
    if (box && width === 1440) {
      const frameHeight = Math.round(box.height) + 20;
      const frameWidth = Math.round(frameHeight / 0.62);
      await page.screenshot({
        path: `${SHOTS}/takeover-preview.png`,
        clip: {
          x: Math.max(0, Math.round(box.x + box.width / 2 - frameWidth / 2)),
          y: Math.max(0, Math.round(box.y) - 10),
          width: Math.min(width, frameWidth),
          height: frameHeight,
        },
      });
    }
  });
}
