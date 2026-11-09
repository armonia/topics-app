/**
 * HUBBR-22: «Processi» opens on the SESSIONS, as the PC's screen does. The
 * Mac's processes are context beside them, folded and read-only: no search, no
 * order, no Close on any process, nothing that closes Topics. The one command
 * is Stop on a session, after an inline confirmation that names it. The Mac
 * backup is one line at the foot.
 *
 * The session is real (helpers/session-seed.ts): a card in progress bound to a
 * chat. It has no live agent, so the board's Stop answers 409 and the row says
 * so: what this proves is that nothing leaves before the confirmation, that
 * the confirmed Stop goes to the card's own address, and that a refusal is
 * shown. The hub is a fake (helpers/fake-hub.ts).
 *
 * Mutation: with `stopTarget` (SessionConsumption.tsx) answering null, «Stop
 * asks first» is red (the session has no Stop); with the Mac's fold open by
 * default, «the centre is the sessions» is red (process rows on open).
 *
 * Video on: the recording is the proof. The shot of the panel goes to the
 * test's output (`processes-sessions.png`).
 *
 * @covers HUBBR-22
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { holdDispatchReconcile, resetPaneStore } from "./helpers/api-fixtures";
import { openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { openPerfPanel } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { feedRounds, seedRunningCard, type RunningCard } from "./helpers/session-seed";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";

hermetic(test);
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "it-IT", video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "machine-processes";
const HOUR = 3_600_000;

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { services?: unknown[] } }>;
    return snap.services?.data?.services?.length ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThan(0);
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await openPerfPanel(page);
  await page.getByTestId("menu-system-processes").click();
  await expect(page.getByTestId(PANE)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("machine-processes-mac")).toBeVisible({ timeout: 20_000 });
}

test.describe("processes: sessions at the centre", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;
  let card: RunningCard | null = null;
  let stopFeeding: () => void = () => {};

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-hub-processi-${Date.now().toString(36)}`);
    hub = await startFakeHub();
    await waitForHub(request);
    await holdDispatchReconcile(request, 240_000);
    card = await seedRunningCard(request, {
      boardId: projectIdForPath(scene.dirOf("acme-web")), topicId: scene.chats["acme-web"][0], text: "Rifare la sincronizzazione del calendario",
      model: "claude-opus-5", holdMB: 320, burnPct: 10, input: 38_000, output: 12_400, cacheRead: 410_000,
    });
    stopFeeding = feedRounds([{ card, perRound: 120 }], 2_000);
  });
  test.afterAll(async ({ request }) => {
    stopFeeding();
    await card?.stop();
    await hub?.close();
    await scene?.cleanup(request);
  });
  test.beforeEach(async ({ request }) => {
    // The session's first reading and the scene take most of the default 30 s on a busy Mac.
    test.setTimeout(150_000);
    if (hub) hub.backup = null;
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("the centre is the sessions: no process row on open, the Mac's processes folded and without Close", async ({ page }, testInfo) => {
    await open(page);
    const sessions = page.getByTestId("machine-processes-sessions");
    await expect(sessions.getByTestId("session-row")).toHaveCount(1, { timeout: 30_000 });
    // Sessions first in reading order, the machine beside them.
    const [sBox, mBox] = await Promise.all([sessions.boundingBox(), page.getByTestId("machine-processes-mac").boundingBox()]);
    expect(sBox!.x).toBeLessThan(mBox!.x);
    expect(sBox!.width).toBeGreaterThan(mBox!.width);
    // Nothing of the old process table on open: no row, no search, no order.
    await expect(page.getByTestId("machine-process-row")).toHaveCount(0);
    await expect(page.getByTestId("machine-processes-search")).toHaveCount(0);
    await expect(page.getByTestId("machine-processes-sort")).toHaveCount(0);
    await expect(page.getByTestId("machine-processes-toggle")).toContainText(/Processi del Mac · \d+ · [\d,]+ GB/);
    await page.screenshot({ path: testInfo.outputPath("processes-sessions.png") });
    // The fold opens read-only: the rows are there, no Close on any of them, nothing that closes Topics.
    await page.getByTestId("machine-processes-toggle").click();
    // The heaviest eight, the rest behind «Altri». allow-italian: UI label under test
    await expect(page.getByTestId("machine-process-row")).toHaveCount(8);
    await expect(page.getByTestId(PANE)).not.toContainText("Chiudi");
    await expect(page.getByTestId(PANE)).not.toContainText("Forza chiusura");
  });

  test("Stop on a session asks first, names it, and only then goes to the card", async ({ page }) => {
    await open(page);
    const row = page.getByTestId("session-row").filter({ hasText: "Rifare la sincronizzazione del calendario" });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    const stops: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/tasks\/[^/]+\/stop$/.test(r.url())) stops.push(r.url()); });
    await row.getByTestId("session-stop").click();
    await expect(row.getByTestId("session-stop-confirm")).toContainText("Fermare «Rifare la sincronizzazione del calendario»?");
    await row.getByTestId("session-stop-confirm-cancel").click();
    await expect(row.getByTestId("session-stop-confirm")).toHaveCount(0);
    expect(stops).toEqual([]);
    await row.getByTestId("session-stop").click();
    await row.getByTestId("session-stop-confirm-yes").click();
    await expect.poll(() => stops.length).toBe(1);
    expect(stops[0]).toContain(`/tasks/${card!.taskId}/stop`);
    // The seeded card has no live agent: the board refuses, and the row says it did not stop.
    await expect(row.getByTestId("session-stop-failed")).toContainText("Non si è fermata");
  });

  test("backup: one line at the foot, with the last good run when the last one failed", async ({ page }) => {
    await open(page);
    const line = page.getByTestId("machine-backup");
    await expect(line).toHaveAttribute("data-state", "none");
    await expect(page.getByTestId("machine-backup-last")).toHaveText("Nessun backup registrato");
    // The view reads the hub every 15 s: the next round brings the new file, no reopening.
    hub!.backup = { last: { at: Date.now() - 5 * HOUR, ok: true, detail: "1,2 GB in 4 min" }, ticks: [] };
    await expect(line).toHaveAttribute("data-state", "ok", { timeout: 25_000 });
    await expect(page.getByTestId("machine-backup-last")).toContainText("ultimo riuscito");
    await expect(page.getByTestId("machine-backup-last")).toContainText("1,2 GB in 4 min");
    // One line: no taller than a line of text.
    expect((await line.boundingBox())!.height).toBeLessThan(24);
    hub!.backup = { last: { at: Date.now() - HOUR, ok: false, detail: "disco pieno" }, ticks: [{ at: Date.now() - 25 * HOUR, ok: true }] };
    await expect(line).toHaveAttribute("data-state", "error", { timeout: 25_000 });
    await expect(page.getByTestId("machine-backup-last")).toContainText("non riuscito");
    await expect(page.getByTestId("machine-backup-last")).toContainText("l'ultimo riuscito è del");
  });
});

test("hub off: no Mac, no backup line", async ({ page }) => {
  await page.goto("/");
  await openPerfPanel(page);
  await page.getByTestId("menu-system-processes").click().catch(() => {});
  await expect(page.getByTestId("machine-processes-mac")).toHaveCount(0);
  await expect(page.getByTestId("machine-backup")).toHaveCount(0);
});
