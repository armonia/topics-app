/**
 * THE BOARD'S «FRENATO» CHIP (hub-smistamento, HUBBR-20).
 *
 * Claude's five-hour window is fed at 94% with a reset ahead, through the same
 * function the CLI's reading goes through (`/api/test/plan-usage`), and two
 * Todo cards pinned to Claude sit on a board that dispatches: the dispatcher
 * keeps them in Todo, and the board says so in four places. The chip names the
 * provider, the share and the time; the Todo column opens with a strip that
 * counts the two held cards; each card names Claude as what holds it; the
 * sidebar's Board row carries the brake's tag. The popover lists Claude held with its two cards,
 * Codex free with its share from the hub, Muse, and where the suites run.
 * Then Codex is held too (`/api/test/provider-hold`) with no card of its own:
 * the chip still names Claude alone, because a wall that holds no card is not
 * a brake, and the popover says Codex holds no card. With the window below the
 * line and no hold, none of the four marks exists. On the phone the chip is a
 * full-width row under the bar.
 *
 * The cards exist only while a brake is in force: they are made after it and
 * deleted before the next test clears it, so no card is ever dispatched.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * the real :3360 is never touched.
 *
 * Mutation: with `dispatchWork` in the dispatcher answering every Todo card of
 * a board as held (the wall alone, without `taskPlanWait`), the Codex check
 * (no card of its own, Claude alone on the chip) is red; without the
 * five-hour rule in `dispatchBrakes` (server/lib/provider-hold.ts) the chip
 * never shows and the first test is red.
 *
 * Video on: the recording is the proof. The pictures of the built surface go
 * to the test's output (`vero-cmdk-e-frenato-*.png`, allow-italian: file names the docs expect).
 *
 * @covers HUBBR-20
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTmpRoot, E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { projectIdForPath } from "../../shared/board";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const HOUR = 3_600_000;
const STAMP = `fr${Date.now().toString(36)}`;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-frenato-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
let projectTopicId: string | null = null;
const CARDS = ["Build firmate per la release", "Onboarding tradotto in tre lingue"];
const made: string[] = [];

/**
 * The bench as a dispatching board needs it: the project's folder with a topic
 * on it (the board resolves its directory from there, or the dispatcher parks
 * the cards in Backlog), and a Claude runtime that reads as ready. The CLI is
 * the bench's stub; its "session" is the `.claude` folder of the home the
 * server reads, which the Windows bench does not seed (`HOME` unset there, so
 * the server looks under its working directory).
 */
async function dispatchingBench(request: APIRequestContext): Promise<void> {
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(join(PROJECT_PATH, "package.json"), JSON.stringify({ name: "e2e-frenato" }));
  projectTopicId = (await createTopic(request, "E2E-Frenato", { projectPath: PROJECT_PATH })).id;
  mkdirSync(join(E2E_HOME, ".claude"), { recursive: true });
  mkdirSync(join(process.cwd(), ".claude"), { recursive: true });
  await expect.poll(async () => {
    await request.post(`${E2E_BASE}/api/providers/snapshot/refresh`, { data: { provider: "claude-code" } });
    const snap = (await (await request.get(`${E2E_BASE}/api/providers/snapshot`)).json()) as { providers: Array<{ name: string; status: string }> };
    return snap.providers.find((p) => p.name === "claude-code")?.status;
  }, { timeout: 30_000, message: "the bench's Claude runtime never read as ready" }).toBe("ready");
}

/** Two Todo cards pinned to the Claude runtime, on a board that dispatches, and the server's word that both are held. */
async function heldCards(request: APIRequestContext): Promise<string[]> {
  const settings = await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`, { data: { autoDispatch: true } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const ids: string[] = [];
  for (const text of CARDS) {
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo", model: "claude-code:auto", topicsRouting: false } });
    expect(res.ok(), await res.text()).toBe(true);
    const id = ((await res.json()) as { id: string }).id;
    made.push(id);
    ids.push(id);
  }
  try {
    await expect.poll(async () => {
      const body = (await (await request.get(`${E2E_BASE}/api/dispatch/brakes`)).json()) as { held?: Array<{ taskId: string; provider: string }> };
      return (body.held ?? []).filter((h) => ids.includes(h.taskId) && h.provider === "claude").length;
    }, { timeout: 20_000 }).toBe(2);
  } catch (err) {
    // The bench's runtimes and the cards as the server sees them: what a red here needs to be read.
    const snapshot = await (await request.get(`${E2E_BASE}/api/providers/snapshot`)).text();
    const brakes = await (await request.get(`${E2E_BASE}/api/dispatch/brakes`)).text();
    const card = await (await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${ids[0]}`)).text();
    throw new Error(`the dispatcher never held the two Claude cards\nbrakes: ${brakes}\nsnapshot: ${snapshot.slice(0, 1500)}\ncard: ${card.slice(0, 800)}\n${String(err)}`);
  }
  return ids;
}

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown[] }>;
    return Array.isArray(snap.pace?.data) ? snap.pace.data.length : -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(3);
}

async function clearBrakes(request: APIRequestContext): Promise<void> {
  await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { clear: true } });
  await request.post(`${E2E_BASE}/api/test/provider-hold`, { data: { provider: "codex", clear: true } });
}

/** «14:20» as the page writes a time, in the browser's own zone. */
function clock(page: Page, ms: number): Promise<string> {
  return page.evaluate((t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }), ms);
}

/**
 * The general board, in a fresh page. The open event is sent again until the
 * board shows: on WebKit the sidebar can paint before the listener that opens
 * the board is mounted, and one event sent into that gap is lost (a 15 s
 * timeout on the first run of the previous round).
 */
async function openBoard(page: Page, request: APIRequestContext): Promise<void> {
  await resetPaneStore(request, []);
  await page.goto(E2E_BASE);
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
    await expect(page.getByTestId("kanban-board").first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/** A reset still within today, so the chip reads the bare clock time on any clock. */
function resetToday(): number {
  const now = Date.now();
  const end = new Date(now);
  end.setHours(23, 59, 0, 0);
  return Math.min(now + 2 * HOUR, end.getTime());
}

test.describe("board: the «Frenato» chip", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
    await dispatchingBench(request);
  });
  test.afterAll(async ({ request }) => {
    await clearBrakes(request);
    if (projectTopicId) await deleteTopic(request, projectTopicId).catch(() => {});
    await hub?.close();
  });
  test.beforeEach(async ({ request }) => { await clearBrakes(request); });
  // Before the next test clears the brakes: a card left in Todo would then be dispatched.
  test.afterEach(async ({ request }) => {
    for (const id of made.splice(0)) await deleteTask(request, PROJECT_ID, id).catch(() => {});
  });

  test("Claude past the line: the chip, the column, the cards, the sidebar, the popover; then Codex with no card of its own", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    const resetsAtMs = resetToday();
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 94, resetsAtMs } } });
    const ids = await heldCards(request);
    await openBoard(page, request);

    const chip = page.getByTestId("board-brake-chip");
    await expect(chip).toBeVisible({ timeout: 20_000 });
    const at = await clock(page, resetsAtMs);
    await expect(chip).toHaveText(`Frenato · Claude · quota 5h al 94%, riparte alle ${at}`);
    const note = page.getByTestId("kanban-column-todo").getByTestId("board-brake-column");
    await expect(note).toHaveText(`2 aspettano il freno di ClaudePartono da sole alle ${at}.`);
    for (const id of ids) {
      await expect(page.locator(`[data-task-card="${id}"]`).getByTestId("board-brake-card")).toHaveText("Aspetta il freno · Claude");
    }
    await expect(page.getByTestId("sidebar-board-brake")).toHaveText("Frenato");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-scuro.png") });

    await chip.click();
    const pop = page.getByTestId("board-brake-pop");
    await expect(pop).toBeVisible();
    const claude = pop.getByTestId("board-brake-row-claude");
    await expect(claude).toHaveAttribute("data-held", "true");
    await expect(claude).toContainText(`Quota 5h al 94%, riparte alle ${at} (soglia 90%) · 2 card aspettano`);
    const codex = pop.getByTestId("board-brake-row-codex");
    await expect(codex).toHaveAttribute("data-held", "false");
    await expect(codex).toContainText("Libero");
    await expect(codex).toContainText("Quota 5h al 8% · nessuna card al lavoro");
    await expect(pop.getByTestId("board-brake-row-muse")).toContainText("Quota fissa · nessuna card al lavoro");
    await expect(pop.getByTestId("board-brake-row-suite")).toContainText("Sul Mac");
    await expect(pop).not.toContainText("Togli il freno");
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-popover-scuro.png") });
    await pop.getByTestId("board-brake-accounts").click();
    await expect(page.getByTestId("accounts-pane")).toBeVisible({ timeout: 20_000 });

    // Codex held too, but no card of the board is Codex's: the chip still
    // names Claude alone, and the popover says Codex holds nothing.
    await request.post(`${E2E_BASE}/api/test/provider-hold`, { data: { provider: "codex", untilMs: resetsAtMs + 60_000, window: "usage_limit" } });
    await openBoard(page, request);
    await expect(page.getByTestId("board-brake-chip")).toHaveText(`Frenato · Claude · quota 5h al 94%, riparte alle ${at}`, { timeout: 20_000 });
    await page.getByTestId("board-brake-chip").click();
    const codexHeld = page.getByTestId("board-brake-pop").getByTestId("board-brake-row-codex");
    await expect(codexHeld).toContainText("Frenato");
    await expect(codexHeld).toContainText("nessuna card ferma adesso");
    await expect(codexHeld).toHaveAttribute("data-held", "false");
  });

  test("light: the chip and its popover", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 94, resetsAtMs: resetToday() } } });
    await heldCards(request);
    await openBoard(page, request);
    const chip = page.getByTestId("board-brake-chip");
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-chiaro.png") });
    await chip.click();
    await expect(page.getByTestId("board-brake-pop")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-popover-chiaro.png") });
  });

  test("phone: a full-width row under the bar", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 94, resetsAtMs: resetToday() } } });
    await heldCards(request);
    await openBoard(page, request);
    const band = page.getByTestId("board-brake-band");
    await expect(band).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("board-brake-chip")).toBeHidden();
    const box = (await band.boundingBox())!;
    expect(box.width).toBeGreaterThan(330);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // The Todo column, where the phone shows one column at a time: its strip and its held cards.
    const todo = page.getByTestId("kanban-column-todo");
    await todo.scrollIntoViewIfNeeded();
    await expect(todo.getByTestId("board-brake-column")).toBeVisible();
    await expect(todo.getByTestId("board-brake-card")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-telefono.png") });
  });

  test("nothing held: no chip", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 60, resetsAtMs: resetToday() } } });
    await openBoard(page, request);
    // The store has read the server: no wall, no held card, and stays so.
    await expect.poll(async () => {
      const body = (await (await request.get(`${E2E_BASE}/api/dispatch/brakes`)).json()) as { brakes: unknown[]; held: unknown[] };
      return [body.brakes.length, body.held.length];
    }).toEqual([0, 0]);
    await expect(page.getByTestId("board-toolbar")).toBeVisible();
    await expect(page.getByTestId("board-brake-chip")).toHaveCount(0);
    await expect(page.getByTestId("board-brake-band")).toHaveCount(0);
    await expect(page.getByTestId("board-brake-column")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-board-brake")).toHaveCount(0);
  });
});
