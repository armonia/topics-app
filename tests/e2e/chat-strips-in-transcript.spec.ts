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
 * Then, on the accordion itself (08/10): «it opens above, not below»; «you
 * can't tell it belongs to that row, it looks like a terminal»; «there's no
 * scroll to go back to the earlier lines»; «I don't get what the little alarm
 * button is for, maybe it isn't a button»; «when I open and then close it, it
 * stays scrolled».
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
const rest = (scrolling: Locator) => scrolling.evaluate((el) => new Promise<void>((resolve, reject) => {
  let last = el.scrollTop;
  let same = 0;
  let frame = 0;
  const tick = () => {
    if (el.scrollTop === last) same++;
    else { last = el.scrollTop; same = 0; }
    if (same >= 10) return resolve();
    if (++frame > 600) return reject(new Error(`never stopped scrolling (scrollTop ${el.scrollTop})`));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
const still = (page: Page) => rest(scroller(page));

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

/** A computed background with nothing painted. */
const CLEAR = "rgba(0, 0, 0, 0)";
const surface = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);

/** How far a command's log is from its first line ("start") or from its last ("end"). */
const logRoom = (live: Locator, side: "start" | "end") =>
  live.evaluate((el, side) => (side === "start" ? el.scrollTop : el.scrollHeight - el.scrollTop - el.clientHeight), side);

/**
 * A wheel inside a command's log, a notch at a time and each landed, until the
 * log shows its first line or its last. Never more than the room left: the
 * rest of a notch would go on to the transcript.
 */
async function wheelLog(page: Page, live: Locator, side: "start" | "end"): Promise<void> {
  const logBox = await box(live);
  const view = await box(scroller(page));
  const composer = await box(page.getByTestId("chat-input-area").filter({ visible: true }));
  await page.mouse.move((logBox.left + logBox.right) / 2, (Math.max(logBox.top, view.top) + Math.min(logBox.bottom, composer.top)) / 2);
  for (let i = 0; i < 40; i++) {
    const room = await logRoom(live, side);
    if (room <= 1) return;
    await page.mouse.wheel(0, side === "start" ? -Math.min(120, room) : Math.min(120, room));
    await rest(live);
  }
  throw new Error(`the log never reached its ${side}`);
}

test("a command's row opens its live log under itself, as the row's own content: the log scrolls back to its first line, a second click shuts it and gives the view back, one log open at a time, the alarm clock is a sign", async ({ page, request, chatPage }) => {
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
  // More commands than the rows the strip showed before scrolling inside itself (7.5rem): lifted to open
  // a log, that cap showed the rows it hid under the one clicked, and the reader at the bottom ended above
  // it (the Prince of Persia chat, six commands, 08/10).
  for (let i = 1; i <= 5; i++) {
    const more = await runCommand(request, "sleep 600", `E2E more ${i} ${STAMP}`);
    await expect(commandRow(page, more)).toHaveCount(1, { timeout: 15_000 });
  }
  await expect.poll(() => fromBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(1);
  const card = page.getByTestId("tool-call-row-toolu_cmdwatch");
  const sc = await box(scroller(page));
  const out = (await card.count()) ? await card.boundingBox() : null;
  expect(!out || out.y + out.height < sc.top + 40, "the card is out of sight before the click").toBe(true);

  // The click opens the log UNDER its row («it opens above, not below», 08/10), with the tail the
  // card shows, moving. The reader at the bottom stays there: the transcript moves up by the log's room
  // and nothing else, so the log comes into sight above the composer with its row right on top of it.
  const header = row.getByRole("button").first();
  const log = row.getByTestId("live-command-log");
  const live = row.getByTestId("shell-live-output");
  const inputArea = page.getByTestId("chat-input-area").filter({ visible: true });
  await still(page);
  const before = await place(header);
  await header.click();
  await expect(row).toHaveAttribute("data-open", "true");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(live).toContainText("CMDWATCH-TICK", { timeout: 10_000 });
  await expect(row.getByTestId("shell-live-status")).toHaveAttribute("data-status", "running");
  await still(page);
  const after = await place(header);
  expect(await header.getAttribute("aria-controls"), "the row's button names the log it opens").toBe(await log.getAttribute("id"));
  const headerBox = await box(header);
  expect((await box(log)).top, "the log is under its row").toBeGreaterThanOrEqual(headerBox.bottom - 1);
  expect(headerBox.top, "the row clicked is in sight").toBeGreaterThanOrEqual((await box(scroller(page))).top - 1);
  expect((await box(log)).bottom, "its log is in sight, above the composer").toBeLessThanOrEqual((await box(inputArea)).top + 1);
  expect(after.fromBottom, "the reader at the bottom stays there").toBeLessThanOrEqual(1);
  expect(after.strip - before.strip, "the log took room in the strip").toBeGreaterThan(40);
  expect(Math.abs(after.scrollTop - before.scrollTop - (after.strip - before.strip)), "the transcript moved by the log's room and nothing else").toBeLessThanOrEqual(1);
  expect(Math.abs(before.header - after.header - (after.strip - before.strip)), "the row went up by the log under it").toBeLessThanOrEqual(1);
  // The row's own content, not a terminal of its own («it looks like a terminal»): no box of its own, on the
  // open row's surface, indented under the row's name.
  expect(await surface(live), "the log has no box of its own").toBe(CLEAR);
  expect(await surface(row), "the open row and its log are one surface").not.toBe(CLEAR);
  expect((await box(live)).left, "the log is indented under its row").toBeGreaterThan(headerBox.left + 16);
  // The card that started the command stays shut, out of sight.
  if (await card.count()) {
    await expect(page.locator('[data-testid="tool-call-row-toolu_cmdwatch"] > button').first()).toHaveAttribute("aria-expanded", "false");
    await expect(card).not.toBeInViewport();
  }
  // A second command, started by the route alone: its row arrives under the reader at the bottom, who
  // stays there. A toggle's hold turned that pin away and the row stayed 24 px below the view
  // (Chromium, 2 runs in 6, 08/10).
  const bare = await runCommand(request, 'for i in $(seq 1 600); do echo "bare tick $i"; sleep 1; done', `E2E bare ${STAMP}`);
  const bareRow = commandRow(page, bare);
  const bareHeader = bareRow.getByRole("button").first();
  await expect(bareRow).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => fromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);

  // The log follows its newest line, printed in colour and read as text: on the Prince of Persia chat
  // (08/10) the escape codes showed as boxes.
  const seen = tickOf(await live.textContent());
  await expect.poll(async () => tickOf(await live.textContent()), { timeout: 6_000 }).toBeGreaterThan(seen);
  expect(await live.textContent()).not.toMatch(/\x1b|\[\d*m/);
  await expect.poll(() => live.evaluate((el) => el.scrollHeight > el.clientHeight), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => logRoom(live, "end"), { timeout: 3_000 }).toBeLessThanOrEqual(2);

  // Back to the command's first line, inside the log («there's no scroll to go back to the earlier lines»).
  // Up there the reader stays while new lines arrive. The wheel moved the log and not the chat, which
  // is still at its end and still follows it: a third command's row arrives in sight. Its scroll is no
  // measure of that: the end it follows can still grow (by 4 px, a second after the second row, WebKit
  // 1 run in 6, 08/10).
  await wheelLog(page, live, "start");
  expect(await live.evaluate((el) => (el.textContent ?? "").split("\n")[0]), "the log goes back to the command's first line").toBe("CMDWATCH-TICK 1");
  const upAt = tickOf(await live.textContent());
  await expect.poll(async () => tickOf(await live.textContent()), { timeout: 6_000 }).toBeGreaterThan(upAt + 1);
  await rest(live);
  expect(await logRoom(live, "start"), "new lines leave the reader where they went").toBeLessThanOrEqual(1);
  await expect.poll(() => fromBottom(page), { timeout: 2_000, message: "a wheel in the log moves the log, not the chat" }).toBeLessThanOrEqual(1);
  const third = await runCommand(request, "sleep 600", `E2E third ${STAMP}`);
  await expect(commandRow(page, third)).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => fromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
  // Back at the log's end, it follows again.
  await wheelLog(page, live, "end");
  const backAt = tickOf(await live.textContent());
  await expect.poll(async () => tickOf(await live.textContent()), { timeout: 6_000 }).toBeGreaterThan(backAt);
  await expect.poll(() => logRoom(live, "end"), { timeout: 3_000 }).toBeLessThanOrEqual(2);

  // Opening another row shuts the first: one log open at a time, under the row clicked.
  await still(page);
  await bareHeader.click();
  await expect(bareRow.getByTestId("shell-live-output")).toContainText("bare tick", { timeout: 10_000 });
  await expect(bareRow).toHaveAttribute("data-open", "true");
  await expect(row).toHaveAttribute("data-open", "false");
  await expect(log).toHaveCount(0);
  await expect(strip(page).locator('[data-testid="live-command-row"][data-open="true"]')).toHaveCount(1);
  await still(page);
  expect((await box(bareRow.getByTestId("live-command-log"))).top, "the log is under the row clicked").toBeGreaterThanOrEqual((await box(bareHeader)).bottom - 1);
  expect(await fromBottom(page)).toBeLessThanOrEqual(1);
  // A second click on the same row shuts its log.
  await bareHeader.click();
  await expect(bareRow).toHaveAttribute("data-open", "false");
  await expect(bareHeader).toHaveAttribute("aria-expanded", "false");
  await expect(bareRow.getByTestId("live-command-log")).toHaveCount(0);
  await expect(strip(page).locator('[data-testid="live-command-row"][data-open="true"]')).toHaveCount(0);
  await still(page);
  expect(await fromBottom(page)).toBeLessThanOrEqual(1);

  // Shut, the view is back where it was («when I open and then close it, it stays scrolled»).
  /** One click on the command's row, landed: its log in or out, and the view at rest. */
  const toggle = async (open: boolean) => {
    await header.click();
    await expect(row).toHaveAttribute("data-open", String(open));
    if (open) await expect(live).toContainText("CMDWATCH-TICK", { timeout: 10_000 });
    else await expect(log).toHaveCount(0);
    await still(page);
  };
  // A reader at the bottom: the same bottom, the row at the same height, no room left under the strip.
  const p0 = await place(header);
  await toggle(true);
  await toggle(false);
  const p1 = await place(header);
  expect(Math.abs(p1.scrollTop - p0.scrollTop), "the view is back where it was").toBeLessThanOrEqual(1);
  expect(Math.abs(p1.header - p0.header), "the row is back at its height").toBeLessThanOrEqual(1);
  expect(p1.fromBottom, "at the bottom").toBeLessThanOrEqual(1);
  expect(await surface(row), "shut, the row has no surface of its own").toBe(CLEAR);
  // A reader who went up the chat with the log open: shutting it lets the end come down instead of
  // keeping empty room under the strip, and the view is back at the bottom the log was opened from.
  await toggle(true);
  const view = await box(scroller(page));
  await page.mouse.move((view.left + view.right) / 2, view.top + 60);
  await page.mouse.wheel(0, -100);
  await still(page);
  expect(await fromBottom(page), "the reader went up").toBeGreaterThan(4);
  await toggle(false);
  const p2 = await place(header);
  expect(Math.abs(p2.scrollTop - p0.scrollTop), "the view is back at the bottom the log was opened from").toBeLessThanOrEqual(1);
  expect(p2.fromBottom).toBeLessThanOrEqual(1);
  // A reader further up: the row stays where it is, open and shut, and so does the view.
  await page.mouse.move((view.left + view.right) / 2, view.top + 60);
  await page.mouse.wheel(0, -100);
  await still(page);
  const q0 = await place(header);
  expect(q0.fromBottom, "the reader is above the end").toBeGreaterThan(4);
  await toggle(true);
  expect(Math.abs((await place(header)).header - q0.header), "the row stays where it was").toBeLessThanOrEqual(1);
  expect((await box(log)).top, "its log under it").toBeGreaterThanOrEqual((await box(header)).bottom - 1);
  await toggle(false);
  const q1 = await place(header);
  expect(Math.abs(q1.header - q0.header), "shut, the row is where it was").toBeLessThanOrEqual(1);
  expect(Math.abs(q1.scrollTop - q0.scrollTop), "and so is the view").toBeLessThanOrEqual(1);
  for (let i = 0; i < 6 && (await fromBottom(page)) > 1; i++) {
    await page.mouse.wheel(0, 300);
    await still(page);
  }
  expect(await fromBottom(page), "back at the bottom").toBeLessThanOrEqual(1);

  // The alarm clock says that the command's end wakes the chat: a sign in the row's label, not a third
  // button («maybe it isn't a button», 08/10). No role of a control, no focus, no hover of its own, and a
  // tooltip that says what it means.
  const wakes = row.getByTestId("live-work-wakes");
  await expect(wakes).toBeVisible();
  await expect(wakes).not.toHaveAttribute("role", "button");
  expect(await wakes.evaluate((el) => el.parentElement?.closest("button") !== null), "part of the row's own button").toBe(true);
  expect(await wakes.evaluate((el) => (el as HTMLElement).tabIndex), "not a stop of the keyboard").toBeLessThan(0);
  expect(await wakes.evaluate((el) => { (el as HTMLElement).focus(); return document.activeElement === el; }), "it cannot take the focus").toBe(false);
  const meaning = await wakes.getAttribute("aria-label");
  expect(meaning, "it says what it means").toMatch(/the chat wakes up|la chat si sveglia/);
  await expect(wakes).toHaveAttribute("title", meaning!);
  expect(await header.evaluate((el) => el.getAttribute("aria-describedby")), "the row's button is described by it").toBe(await wakes.getAttribute("id"));
  await wakes.hover();
  expect(await wakes.evaluate((el) => getComputedStyle(el).cursor), "no hand of a button").toBe("default");
  expect(await surface(wakes), "no hover of its own").toBe(CLEAR);
  await expect(page.getByTestId("app-tooltip"), "its tooltip says it").toContainText(meaning!);

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
