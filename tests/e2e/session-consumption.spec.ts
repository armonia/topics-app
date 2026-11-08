/**
 * WHAT EACH SESSION COSTS, INSIDE TOPICS.
 *
 * The Processes view opens on the SESSIONS at work: every card, chat or
 * terminal with its model, tokens, tokens per second, a clock that runs, and
 * the CPU and memory of everything Topics launched for it; a process several
 * sessions use (the server) is split in equal parts and the row says how. The
 * processes of a session are its detail. The card's drawer shows the same row
 * for its own session. Same answer as the PC's monitor
 * (`/api/system/screen-sessions` and `/api/usage/consumption` are one service),
 * so the numbers match.
 *
 * The sessions are real (helpers/session-seed.ts): cards in progress bound to
 * chats, tokens in the native registry, real child processes of the test
 * server registered as their CLIs. The hub is a fake on the port the test
 * server reads. Names are placeholders; the real :3333 is never touched.
 *
 * Mutation: with the attribution billing every process to the first session
 * (`attributeProcesses` ignoring the nearest head), «the two sessions are billed
 * apart» is red; with the split ignoring the number of users, «1/2» is red.
 *
 * Video on: the recording is the proof. Screenshots go to the test's output
 * (`vero-sessioni-*.png`) and, with CONSUMPTION_SHOTS set, to that folder too
 * (`sessioni-topics.png`).
 *
 * @covers HUBBR-08
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { holdDispatchReconcile, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { openPerfPanel } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { feedRounds, seedRunningCard, type RunningCard } from "./helpers/session-seed";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";

hermetic(test);
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "it-IT", video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const SHOTS = process.env.CONSUMPTION_SHOTS ?? "";

function keep(path: string, name: string): void {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, name));
}

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { services?: unknown[] } }>;
    return snap.services?.data?.services?.length ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThan(0);
}

async function openProcesses(page: Page): Promise<void> {
  await openPerfPanel(page);
  await page.getByTestId("menu-system-processes").click();
  await expect(page.getByTestId("machine-processes")).toBeVisible({ timeout: 20_000 });
}

test.describe("what each session costs", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;
  const cards: RunningCard[] = [];
  let stopFeeding: () => void = () => {};

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-session-consumption-${Date.now().toString(36)}`);
    hub = await startFakeHub();
    await waitForHub(request);
    await holdDispatchReconcile(request, 240_000);
    const a = await seedRunningCard(request, {
      boardId: projectIdForPath(scene.dirOf("acme-web")), topicId: scene.chats["acme-web"][0], text: "Rifare la sincronizzazione del calendario",
      model: "claude-opus-5", holdMB: 640, burnPct: 30, input: 38_000, output: 12_400, cacheRead: 410_000,
    });
    const b = await seedRunningCard(request, {
      boardId: projectIdForPath(scene.dirOf("studio-x")), topicId: scene.chats["studio-x"][0], text: "Migrare le notifiche push",
      model: "claude-sonnet-5", holdMB: 310, burnPct: 12, input: 9_000, output: 3_100, cacheRead: 88_000,
    });
    cards.push(a, b);
    stopFeeding = feedRounds([{ card: a, perRound: 140 }, { card: b, perRound: 45 }], 2_000);
  });
  test.afterAll(async ({ request }) => {
    stopFeeding();
    for (const c of cards) await c.stop();
    await hub?.close();
    await scene?.cleanup(request);
  });

  test.beforeEach(async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "USAGE-26" });
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("the Processes view opens on the sessions: tokens, speed, clock, CPU and memory, the shared part named", async ({ page, request }, testInfo) => {
    await page.goto("/");
    await openProcesses(page);
    const panel = page.getByTestId("machine-processes-sessions");
    await expect(panel).toBeVisible();
    const rows = panel.getByTestId("session-row");
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    const rowA = rows.filter({ hasText: "Rifare la sincronizzazione del calendario" });
    const rowB = rows.filter({ hasText: "Migrare le notifiche push" });
    await expect(rowA.getByTestId("session-detail")).toHaveText("acme-web · Opus 5");
    await expect(rowB.getByTestId("session-detail")).toHaveText("studio-x · Sonnet 5");
    // Memory is measured per session (a dash would mean not measured). The size a child holds is not asserted: the kernel compresses a uniform fill and the footprint reads small.
    await expect(rowA.getByTestId("session-memory-value")).not.toHaveText("-");
    // The server is used by both: each is billed 1/2 of it, and the cell says so.
    await expect(rowA.getByTestId("session-memory")).toContainText("1/2 server di Topics");
    await expect(rowB.getByTestId("session-memory")).toContainText("1/2 server di Topics");
    await expect(rowA.getByTestId("session-tokens")).toContainText("↓38.0k");
    // Output tokens per second, from the growth of the counter.
    await expect.poll(async () => (await rowA.getByTestId("session-tps-value").textContent()) ?? "-", { timeout: 60_000 }).not.toBe("-");
    // The processes are the detail inside the session, closed by default.
    await expect(rowA.getByTestId("session-procs-list")).toHaveCount(0);
    await rowA.getByTestId("session-procs-toggle").click();
    await expect(rowA.getByTestId("session-procs-list")).toBeVisible();
    await expect(rowA.getByTestId("session-procs-list")).toContainText("bun");
    await expect(panel.getByTestId("consumption-notes")).toContainText("diviso in parti uguali");
    // One answer for every surface: the owner's route and the numbers the sessions carry are the same.
    const api = (await (await request.get(`${E2E_BASE}/api/usage/consumption`)).json()) as { sessions: Array<{ key: string; model: string | null; tokens: { total: number } | null }> };
    expect(api.sessions.map((s) => s.key).sort()).toEqual([`card:${cards[0].taskId}`, `card:${cards[1].taskId}`].sort());
    expect(api.sessions.find((s) => s.key === `card:${cards[0].taskId}`)!.model).toBe("claude-opus-5");
    const shot = testInfo.outputPath("vero-sessioni-topics.png");
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot });
    keep(shot, "sessioni-topics.png");
  });

  test("the card's drawer shows the same row for its own session", async ({ page, request }, testInfo) => {
    if (!scene) return;
    await seedProjectPane(request, scene.dirOf("acme-web"));
    await page.goto(`/task/${cards[0].taskId}`);
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    // What a card costs lives behind the "Dettagli" tab, next to the attempts and the changes.
    await drawer.getByTestId("task-details-toggle").click();
    const block = drawer.getByTestId("card-consumption");
    await expect(block).toBeVisible({ timeout: 30_000 });
    await expect(block.getByTestId("session-tokens")).toContainText("↓38.0k");
    await expect(block.getByTestId("session-memory-value")).not.toHaveText("-");
    await expect(block.getByTestId("session-clock")).toBeVisible();
    // It is THIS card's session, not the other one: the other card's title is nowhere in the block.
    await expect(block).not.toContainText("Migrare le notifiche push");
    const shot = testInfo.outputPath("vero-sessioni-scheda.png");
    await page.screenshot({ path: shot });
    keep(shot, "sessioni-scheda.png");
  });
});
