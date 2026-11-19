/**
 * pairing-approval-card.spec.ts - what the approval card SAYS when a server asks
 * for this node's channel (cards cc704bfa and a97724c1).
 *
 * A request that declares a machine id and an epoch is not a phone asking for a
 * device slot, it is a server asking to become this node's primary. The card
 * says that in plain words, with the epoch and WHO loses the channel, so
 * approving is an informed act. "Who" is a machine a person can recognise: the
 * name of the row in `machines`, not its id.
 *
 * The state is real, not drawn: the spec seeds a machine row through the
 * suite's setup verb, pairs it from loopback so the node records it as its
 * channel, and then a ghost server asks to take that channel over. The card
 * reads the request from `/api/auth/pair/pending` as it does in production.
 *
 * The "before" state is the SAME request as a server without the name sends
 * it (the field stripped on the wire): the card falls back to a short id, which
 * is what it showed in place of the name until this card. The shots at 375 and
 * 1440 px are the before/after the eye judges.
 * @covers MACHINE-01
 */
import { test, expect } from "./fixtures/test-fixtures";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";
import { mkdirSync } from "fs";
import { homedir } from "os";

hermetic(test);

const SHOTS = `${homedir()}/.topics/media/pairing-card`;
const MACHINE_NAME = "Studio Mac";
const MACHINE_HEADER = "x-topics-machine-id";
const EPOCH_HEADER = "x-topics-primary-epoch";

/**
 * The shots also ride on the test's attachments: on a CI runner the media
 * folder is thrown away with the machine, while the attachments travel in the
 * trace the delivery workflow uploads, at full resolution.
 */
async function attachShots(testInfo: TestInfo, state: "before" | "after", width: number): Promise<void> {
  for (const file of [`${state}-${width}.png`, `${state}-card-${width}.png`]) {
    await testInfo.attach(file, { path: `${SHOTS}/${file}`, contentType: "image/png" });
  }
}

/**
 * The node's channel held by a real machine row, and a ghost server asking to
 * take it over at epoch 50. Returns the ghost request, to deny once done: a
 * pending request outlives the file and would knock on the next spec's screen.
 */
async function seedChannelHandover(request: APIRequestContext): Promise<{ machineId: string; ghostRequestId: string }> {
  const seeded = await request.post(`${E2E_BASE}/api/test/machines`, { data: { name: MACHINE_NAME } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const { machine } = await seeded.json() as { machine: { id: string } };

  // The machine pairs this node and becomes its channel: approved from loopback, as a person at this computer does.
  const asked = await request.post(`${E2E_BASE}/api/auth/pair/request`, { headers: { [MACHINE_HEADER]: machine.id, [EPOCH_HEADER]: "1" } });
  const { requestId } = await asked.json() as { requestId: string };
  const approved = await request.post(`${E2E_BASE}/api/auth/pair/approve`, { data: { requestId } });
  expect(approved.ok(), await approved.text()).toBe(true);

  const ghost = await request.post(`${E2E_BASE}/api/auth/pair/request`, { headers: { [MACHINE_HEADER]: crypto.randomUUID(), [EPOCH_HEADER]: "50" } });
  const { requestId: ghostRequestId } = await ghost.json() as { requestId: string };
  const pending = await (await request.get(`${E2E_BASE}/api/auth/pair/pending`)).json() as {
    requests: { id: string; currentPrimaryMachineId: string | null; currentPrimaryMachineName: string | null }[];
  };
  expect(pending.requests.find((r) => r.id === ghostRequestId), "the server names the machine from its own table").toMatchObject({
    currentPrimaryMachineId: machine.id,
    currentPrimaryMachineName: MACHINE_NAME,
  });
  return { machineId: machine.id, ghostRequestId };
}

async function openCard(page: Page, stripName: boolean) {
  if (stripName) {
    // An older server: the same request without the machine's name.
    await page.route("**/api/auth/pair/pending", async (route) => {
      const res = await route.fetch();
      const body = await res.json() as { requests: Record<string, unknown>[] };
      await route.fulfill({ response: res, json: { requests: body.requests.map(({ currentPrimaryMachineName: _n, ...r }) => r) } });
    });
  }
  await goToApp(page);
  const card = page.getByTestId("pair-request-card").filter({ hasText: /epoc[ah] 50/i });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

let seeded: { machineId: string; ghostRequestId: string } | null = null;

test.beforeAll(async ({ request }) => {
  seeded = await seedChannelHandover(request);
});

test.afterAll(async ({ request }) => {
  if (seeded) await request.post(`${E2E_BASE}/api/auth/pair/deny`, { data: { requestId: seeded.ghostRequestId } });
});

for (const [width, height] of [[375, 812], [1440, 900]] as const) {
  test(`before: without the name the card can only show a short id, at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const card = await openCard(page, true);
    await expect(card).toContainText(seeded!.machineId.slice(0, 8));
    await expect(card).not.toContainText(MACHINE_NAME);
    mkdirSync(SHOTS, { recursive: true });
    // The whole viewport, not the card alone: the card is a fixed 320px, so a
    // crop would look the same at every width and prove nothing about how it
    // sits on a phone against a desktop.
    await page.screenshot({ path: `${SHOTS}/before-${width}.png` });
    await card.screenshot({ path: `${SHOTS}/before-card-${width}.png` });
    await attachShots(testInfo, `before`, width);
  });

  test(`after: the card names the epoch and the machine that loses the channel, at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const card = await openCard(page, false);
    await expect(card).toContainText(/epoc[ah] 50/i);
    await expect(card).toContainText(MACHINE_NAME);
    await expect(card).not.toContainText(seeded!.machineId.slice(0, 8));
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/after-${width}.png` });
    await card.screenshot({ path: `${SHOTS}/after-card-${width}.png` });
    await attachShots(testInfo, `after`, width);
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
