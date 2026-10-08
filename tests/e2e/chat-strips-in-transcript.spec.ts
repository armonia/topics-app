/**
 * THE CHAT'S STRIPS ARE THE END OF THE TRANSCRIPT, AND A COMMAND OF THE STRIP
 * OPENS ITS LIVE LOG IN ITS OWN ROW (chat-strips-in-transcript).
 *
 * Attilio, 08/10, on the Prince of Persia chat: a row of the live-work strip
 * opened a second log over the strip «instead of using the one the agent
 * already has», and the goal, the todo list and the other strips «should stay
 * at the end of the chat» instead of docked over the composer. Once the row
 * opened the card that started the command, up in the history: «they open
 * where they were opened», when they should open «right from the panel at the
 * bottom of the chat, as an accordion».
 *
 * Real pieces only. The commands start through the route `run_command` calls,
 * or from a fake CLI turn that calls `run_command` through the bridge's own code
 * (`helpers/fake-claude-command.ts`), so the card is the one a real turn draws.
 *
 * @covers CHAT-END-01 SUBSTRIP-02
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { installFakeCli } from "./helpers/fake-claude-cli";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 180_000 });

const STAMP = Date.now();
const encode = encodeURIComponent;

let project = "";
let topicId = "";
let sessionKey = "";
let switches = "";
let removeCli: (() => void) | null = null;
const processes: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of processes.splice(0)) await request.post(`${E2E_BASE}/api/scripts/${id}/stop`).catch(() => {});
  removeCli?.();
  removeCli = null;
  // The fake's command stops once its folder is gone: it never outlives the test.
  if (switches) rmSync(switches, { recursive: true, force: true });
  if (topicId) await deleteTopic(request, topicId).catch(() => {});
  if (project) removeTmpDir(project);
  topicId = sessionKey = project = switches = "";
});

/** A chat bound to a scratch project: `run_command` runs in the chat's project. */
async function chatWithProject(request: APIRequestContext, label: string, provider?: string): Promise<void> {
  project = canonicalTmpDir(`e2e-end-strips-${label}`);
  mkdirSync(project, { recursive: true });
  topicId = (await createTopic(request, `E2E end strips ${label} ${STAMP}`, { projectPath: project, ...(provider ? { provider } : {}) })).id;
  const { topics } = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { sessionKey: string }> };
  sessionKey = topics[topicId]?.sessionKey ?? "";
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey`);
}

/** The chat open in its project window, as the person has it. */
async function openChat(page: Page, request: APIRequestContext): Promise<void> {
  await resetPaneStore(request, []);
  await seedProjectPane(request, project);
  await seedProjectInnerChats(request, project, [topicId]);
  await waitForPaneStoreQuiet(request);
  await goToApp(page);
  await expect(page.locator(`[data-testid="project-window"][data-project-path="${project}"]`)).toHaveCount(1, { timeout: 20_000 });
}

/** `run_command` from the chat's session, as the MCP tool calls it. */
async function runCommand(request: APIRequestContext, command: string, description: string): Promise<string> {
  const res = await request.post(`${E2E_BASE}/api/sessions/${encode(sessionKey)}/commands/run`, { data: { command, description } });
  expect(res.ok(), `run refused: ${res.status()} ${await res.text()}`).toBe(true);
  const { processId } = (await res.json()) as { processId: string };
  processes.push(processId);
  return processId;
}

const scroller = (page: Page) => page.locator('[data-testid="chat-message-list"]:visible');
const fromBottom = (page: Page) => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const strip = (page: Page) => page.getByTestId("subagents-strip");
const commandRow = (page: Page, processId: string) => strip(page).locator(`[data-testid="live-command-row"][data-process-id="${processId}"]`);
const tickOf = (text: string | null) => Number(text?.match(/CMDWATCH-TICK (\d+)(?![\s\S]*CMDWATCH-TICK)/)?.[1] ?? 0);

async function box(locator: Locator): Promise<{ top: number; bottom: number; left: number; right: number }> {
  const b = await locator.boundingBox();
  expect(b, "on screen to be measured").not.toBeNull();
  return { top: b!.y, bottom: b!.y + b!.height, left: b!.x, right: b!.x + b!.width };
}

/**
 * Ten frames in a row with the transcript at the same scroll position. A wheel
 * can still be landing when `mouse.wheel` returns: WebKit for Linux animates it
 * (CI 08/10: the reader "moved" 54 and then 11 px with the view still gliding),
 * and a place read before the view stops is no baseline for what moves it next.
 */
const still = (page: Page) => scroller(page).evaluate((el) => new Promise<void>((resolve, reject) => {
  let last = el.scrollTop;
  let same = 0;
  let frame = 0;
  const tick = () => {
    if (el.scrollTop === last) same++;
    else { last = el.scrollTop; same = 0; }
    if (same >= 10) return resolve();
    if (++frame > 600) return reject(new Error(`the transcript never stopped scrolling (scrollTop ${el.scrollTop})`));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

/** The first seeded message wholly on screen, by the words that name it ("Reply 21."). */
async function firstInSight(page: Page): Promise<string> {
  const label = await scroller(page).evaluate((el) => {
    const view = el.getBoundingClientRect();
    for (const m of el.querySelectorAll('[data-testid="chat-message"]')) {
      const r = m.getBoundingClientRect();
      const name = (m.textContent ?? "").match(/(Question \d+:|Reply \d+\.)/)?.[1];
      if (name && r.top >= view.top + 60 && r.bottom <= view.bottom - 200) return name;
    }
    return null;
  });
  expect(label, "a seeded message in sight").not.toBeNull();
  return label!;
}

test("the strips are the end of the transcript: after the last message, out of the composer's block, and a reader at the bottom stays there while they change, one further up does not move", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "CHAT-END-01" });
  await chatWithProject(request, "end");
  for (let i = 0; i < 30; i++) {
    await seedMessage(request, {
      sessionKey,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `Question ${i}: what about the next part?` : `Reply ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(1 + (i % 4))}`,
    });
  }
  await openChat(page, request);
  const last = page.getByTestId("chat-message").filter({ hasText: "Reply 29." });
  await expect(last).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fromBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(1);

  // A command starts while the reader is at the bottom: its row is in sight, and the reader still at the bottom.
  const first = await runCommand(request, "sleep 600", `E2E first ${STAMP}`);
  await expect(commandRow(page, first)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fromBottom(page), { timeout: 2_000 }).toBeLessThanOrEqual(1);

  // Where it is: in the transcript, after its last message, above the composer and on its column; not in the composer's block.
  const transcript = page.getByTestId("chat-scroll-container").filter({ has: strip(page) });
  await expect(transcript.getByTestId("chat-end-strips").getByTestId("subagents-strip")).toHaveCount(1);
  const inputArea = page.getByTestId("chat-input-area").filter({ visible: true });
  await expect(inputArea.getByTestId("subagents-strip")).toHaveCount(0);
  const stripBox = await box(strip(page));
  const areaBox = await box(inputArea);
  expect(stripBox.top).toBeGreaterThanOrEqual((await box(last)).bottom - 1);
  expect(stripBox.bottom).toBeLessThanOrEqual(areaBox.top + 1);
  expect(stripBox.left).toBeGreaterThanOrEqual(areaBox.left - 1);
  expect(stripBox.right).toBeLessThanOrEqual(areaBox.right + 1);

  // The goal arrives: one more strip at the end, the reader still at the bottom and the goal in sight.
  const goal = await request.put(`${E2E_BASE}/api/topics/${topicId}/goal`, { data: { content: `E2E goal ${STAMP}: ship the strips` } });
  expect(goal.ok(), "the goal is set").toBe(true);
  await expect(transcript.getByTestId("chat-end-strips").getByTestId("goal-bar")).toBeVisible({ timeout: 15_000 });
  await expect(inputArea.getByTestId("goal-bar")).toHaveCount(0);
  await expect.poll(() => fromBottom(page), { timeout: 2_000 }).toBeLessThanOrEqual(1);
  expect((await box(page.getByTestId("goal-bar"))).bottom).toBeLessThanOrEqual(areaBox.top + 1);

  // A reader further up: the strips change under them and nothing on screen moves.
  // Up in the middle of the history, not at its top: at scrollTop 0 a shift up
  // is clamped away and the check below could not see it. One notch at a time,
  // each landed before the next: on WebKit for Linux a notch is animated and
  // can be cut short, so how far it goes varies (CI 08/10: three notches ended
  // 446-573 px from the bottom). Where the reader ends up is what counts.
  const sc = await box(scroller(page));
  await page.mouse.move((sc.left + sc.right) / 2, (sc.top + sc.bottom) / 2);
  for (let i = 0; i < 8 && (await fromBottom(page)) <= 600; i++) {
    await page.mouse.wheel(0, -300);
    await still(page);
  }
  expect(await fromBottom(page), "the reader is well above the end").toBeGreaterThan(600);
  expect(await scroller(page).evaluate((el) => el.scrollTop), "the reader is not at the top of the history").toBeGreaterThan(100);
  const read = page.getByTestId("chat-message").filter({ hasText: await firstInSight(page) });
  const before = (await box(read)).top;
  const second = await runCommand(request, "sleep 600", `E2E second ${STAMP}`);
  await expect(commandRow(page, second)).toHaveCount(1, { timeout: 20_000 });
  // Read once the view has stopped: a shift that takes a few frames is measured whole.
  await still(page);
  expect(Math.abs((await box(read)).top - before), "a row arriving under the reader moves nothing").toBeLessThanOrEqual(1);
  await request.post(`${E2E_BASE}/api/scripts/${first}/stop`);
  await expect(commandRow(page, first)).toHaveCount(0, { timeout: 15_000 });
  await still(page);
  expect(Math.abs((await box(read)).top - before), "a row leaving under the reader moves nothing").toBeLessThanOrEqual(1);
  expect(await fromBottom(page)).toBeGreaterThan(300);
});

/**
 * Where the transcript is and where `header` is on screen, read in one frame:
 * the log of a command row grows by itself, so two reads could straddle a line.
 */
const place = (header: Locator) => header.evaluate((el) => {
  const list = el.closest('[data-testid="chat-message-list"]');
  const rows = el.closest('[data-testid="subagents-strip"]');
  if (!list || !rows) throw new Error("the row is not in a transcript's strip");
  return {
    scrollTop: list.scrollTop,
    fromBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
    strip: rows.getBoundingClientRect().height,
    header: el.getBoundingClientRect().top,
  };
});

test("a command's row opens its live log right there, as an accordion: the transcript does not go to the card that started it, a second click shuts it, one log open at a time", async ({ page, request, chatPage }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-02" });
  switches = realpathSync(mkdtempSync(join(tmpdir(), "cmdwatch-")));
  await chatWithProject(request, "card", "claude-code");
  removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-command.ts"), {
    CMDWATCH_DIR: switches, CMDWATCH_CWD: project, CMDWATCH_TICKS: "1", CMDWATCH_DONE_LINES: "60",
  });
  await openChat(page, request);
  await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

  // A turn starts the command with `run_command` and ends with 60 lines that push its card out of sight.
  await chatPage.sendMessage("cmdwatch-start");
  await expect(page.getByText("HOLDING").first()).toBeVisible({ timeout: 30_000 });
  writeFileSync(join(switches, "run"), "");
  const row = strip(page).locator('[data-testid="live-command-row"]').filter({ hasText: "CMDWATCH-JOB" });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText("STARTED").first()).toBeVisible({ timeout: 30_000 });
  writeFileSync(join(switches, "release"), "");
  await expect(page.getByText("filler 60")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => fromBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(1);
  const card = page.getByTestId("tool-call-row-toolu_cmdwatch");
  const sc = await box(scroller(page));
  const out = (await card.count()) ? await card.boundingBox() : null;
  expect(!out || out.y + out.height < sc.top + 40, "the card is out of sight before the click").toBe(true);

  // The click opens the row where it is, with the tail the card shows, moving. The row stays under the
  // pointer and the reader at the bottom stays there: the transcript moves by the log's room, nothing else.
  const header = row.getByRole("button").first();
  await still(page);
  const before = await place(header);
  await header.click();
  await expect(row).toHaveAttribute("data-open", "true");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const live = row.getByTestId("shell-live-output");
  await expect(live).toContainText("CMDWATCH-TICK", { timeout: 10_000 });
  await expect(row.getByTestId("shell-live-status")).toHaveAttribute("data-status", "running");
  await still(page);
  const after = await place(header);
  expect(Math.abs(after.header - before.header), "the row stays under the pointer").toBeLessThanOrEqual(1);
  expect(after.fromBottom, "the reader at the bottom stays there").toBeLessThanOrEqual(1);
  expect(after.strip - before.strip, "the log took room in the strip").toBeGreaterThan(40);
  expect(Math.abs(after.scrollTop - before.scrollTop - (after.strip - before.strip)), "the transcript moved by the log's room and nothing else").toBeLessThanOrEqual(1);
  // The card that started the command stays shut, out of sight.
  if (await card.count()) {
    await expect(page.locator('[data-testid="tool-call-row-toolu_cmdwatch"] > button').first()).toHaveAttribute("aria-expanded", "false");
    await expect(card).not.toBeInViewport();
  }
  const seen = tickOf(await live.textContent());
  await expect.poll(async () => tickOf(await live.textContent()), { timeout: 6_000 }).toBeGreaterThan(seen);
  // Printed in colour, read as text: on the Prince of Persia chat (08/10) the escape codes showed as boxes.
  expect(await live.textContent()).not.toMatch(/\x1b|\[\d*m/);
  // Once the log outgrows its box, the box shows its newest line.
  await expect.poll(() => live.evaluate((el) => el.scrollHeight > el.clientHeight), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => live.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 3_000 }).toBeLessThanOrEqual(2);

  // A second command, started by the route alone: opening its row shuts the first. One log open at a time.
  const bare = await runCommand(request, 'for i in $(seq 1 600); do echo "bare tick $i"; sleep 1; done', `E2E bare ${STAMP}`);
  const bareRow = commandRow(page, bare);
  const bareHeader = bareRow.getByRole("button").first();
  await expect(bareRow).toHaveCount(1, { timeout: 15_000 });
  await still(page);
  const beforeBare = await place(bareHeader);
  await bareHeader.click();
  await expect(bareRow.getByTestId("shell-live-output")).toContainText("bare tick", { timeout: 10_000 });
  await expect(bareRow).toHaveAttribute("data-open", "true");
  await expect(row).toHaveAttribute("data-open", "false");
  await expect(row.getByTestId("live-command-log")).toHaveCount(0);
  await expect(strip(page).locator('[data-testid="live-command-row"][data-open="true"]')).toHaveCount(1);
  await still(page);
  expect(Math.abs((await place(bareHeader)).header - beforeBare.header), "the row clicked stays under the pointer").toBeLessThanOrEqual(1);

  // The second click on the same row shuts its log, and the row stays where it was.
  const beforeShut = await place(bareHeader);
  await bareHeader.click();
  await expect(bareRow).toHaveAttribute("data-open", "false");
  await expect(bareHeader).toHaveAttribute("aria-expanded", "false");
  await expect(bareRow.getByTestId("live-command-log")).toHaveCount(0);
  await expect(strip(page).locator('[data-testid="live-command-row"][data-open="true"]')).toHaveCount(0);
  await still(page);
  const shut = await place(bareHeader);
  expect(Math.abs(shut.header - beforeShut.header), "the row stays under the pointer as its log shuts").toBeLessThanOrEqual(1);
  expect(shut.fromBottom).toBeLessThanOrEqual(1);

  // The command ends with its log open: its row stays, says how it ended with its last lines, and has no Stop.
  await header.click();
  await expect(live).toContainText("CMDWATCH-TICK", { timeout: 10_000 });
  writeFileSync(join(switches, "finish"), "");
  await expect(row.getByTestId("shell-live-status")).toHaveAttribute("data-status", "ended", { timeout: 15_000 });
  await expect(live).toContainText("CMDWATCH-LAST 42");
  await expect(row.getByTestId("live-work-stop")).toHaveCount(0, { timeout: 15_000 });
  await expect(row).toHaveAttribute("data-open", "true");
  // Its end wakes the chat, which answers below: the reader at the bottom stays there.
  await expect(page.getByText("CMD-WOKEN").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => fromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
  // A click shuts the log, and the ended row goes with it.
  await header.click();
  await expect(row).toHaveCount(0, { timeout: 5_000 });
  await expect(bareRow).toHaveCount(1);
  await expect.poll(() => fromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
});
