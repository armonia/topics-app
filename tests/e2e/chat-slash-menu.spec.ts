import { expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installReplayCli } from "./helpers/fake-claude-cli";

hermetic(test);
test.describe.configure({ timeout: 150_000 });

/**
 * THE «/» MENU OFFERS WHAT WORKS IN THE OPEN CHAT, IN THREE GROUPS (CMDUI-01,
 * CMDUI-07).
 *
 * The CLI is `fake-claude-replay.ts`: it plays the `system/init` Claude Code
 * 2.1.288 wrote (its `slash_commands`) and writes down every message it is
 * handed, so «the CLI received `/review`» is read from its log. The person's
 * skills are folders under the test server's HOME: `vai`, and `spenta`,  allow-italian: skill names
 * switched off in `skillOverrides`.
 *
 * @covers CMDUI-01, CMDUI-07, CMD-06, SKILL-01
 */

const LOG = join(E2E_HOME, "fake-cli-slash-menu.jsonl");
const SKILLS = join(E2E_HOME, ".claude", "skills");
const SETTINGS = join(E2E_HOME, ".claude", "settings.json");
let settingsBefore: string | null = null;

interface LogLine { event: string; text?: string; last?: string }
const log = (): LogLine[] => (existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine)
  : []);
const received = () => log().filter((l) => l.event === "received").map((l) => l.last ?? l.text ?? "");

const menu = (page: Page) => page.getByTestId("slash-menu");
const row = (page: Page, cmd: string) => menu(page).locator(`[data-testid="slash-menu-row"][data-cmd="${cmd}"]`);
const groups = (page: Page) => menu(page).locator('[role="group"]');

async function openChat(page: Page, chatPage: ChatPage, request: import("@playwright/test").APIRequestContext, id: string, name: string) {
  await resetPaneStore(request, [id]);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(name));
  await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
}

async function send(chatPage: ChatPage, page: Page, text: string) {
  await chatPage.messageInput.click();
  await chatPage.messageInput.fill(text);
  await page.keyboard.press("Escape");
  await chatPage.messageInput.press("Enter");
}

test.describe("the «/» menu of a chat", () => {
  let uninstall: (() => void) | null = null;
  const made: string[] = [];

  test.beforeAll(() => {
    rmSync(LOG, { force: true });
    uninstall = installReplayCli(LOG);
    for (const name of ["vai", "spenta"]) {
      mkdirSync(join(SKILLS, name), { recursive: true });
      writeFileSync(join(SKILLS, name, "SKILL.md"), `---\nname: ${name}\ndescription: la skill ${name}\n---\n\nCorpo.\n`);
    }
    settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS, "utf8") : null;
    const merged = { ...(settingsBefore ? JSON.parse(settingsBefore) as Record<string, unknown> : {}), skillOverrides: { spenta: "off" } };
    writeFileSync(SETTINGS, JSON.stringify(merged));
  });

  test.afterAll(async ({ request }) => {
    uninstall?.();
    for (const name of ["vai", "spenta"]) rmSync(join(SKILLS, name), { recursive: true, force: true });
    if (settingsBefore === null) rmSync(SETTINGS, { force: true }); else writeFileSync(SETTINGS, settingsBefore);
    for (const id of made) await deleteTopic(request, id);
  });

  test("on Claude Code: Topics, Claude Code and Your skills; /init and /code-review are «turno»; no /review, /agents or switched-off skill; /review typed reaches the CLI as /review", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMDUI-01" });
    const name = `slash-menu-cc-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    made.push(topic.id);
    await openChat(page, chatPage, request, topic.id, name);
    // One turn: the CLI says its commands in its `init`.
    await send(chatPage, page, "ciao menu");
    await expect(chatPage.messageList).toContainText("got: ciao menu", { timeout: 40_000 });

    await chatPage.messageInput.fill("/");
    await expect(menu(page)).toBeVisible({ timeout: 10_000 });
    await expect(groups(page)).toHaveCount(3);
    await expect(groups(page).nth(0)).toHaveAttribute("aria-label", "Topics");
    await expect(groups(page).nth(1)).toHaveAttribute("aria-label", "Claude Code");
    await expect(groups(page).nth(2)).toHaveAttribute("aria-label", "Le tue skill");
    for (const cmd of ["/init", "/code-review", "/vai"]) {
      await expect(row(page, cmd), cmd).toHaveAttribute("data-turn", "true");
      await expect(row(page, cmd).getByTestId("slash-menu-mark"), cmd).toHaveText("turno");
    }
    await expect(row(page, "/model").getByTestId("slash-menu-mark")).toHaveText("apre il selettore");
    for (const cmd of ["/review", "/agents", "/spenta", "/doctor", "/vim"]) await expect(row(page, cmd), cmd).toHaveCount(0);
    // The line under the list says what the marks mean.
    await expect(menu(page)).toContainText("quelli segnati «turno» fanno lavorare il modello");
    await page.keyboard.press("Escape");

    // An alias is its command: the CLI resolves `/review` itself.
    await send(chatPage, page, "/review");
    await expect.poll(() => received().at(-1) ?? "", { timeout: 30_000 }).toBe("/review");
  });

  test("«/con» filters by name, each in its group, and a group with no rows is gone", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMDUI-01" });
    const name = `slash-menu-filter-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    made.push(topic.id);
    await openChat(page, chatPage, request, topic.id, name);
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/con");
    await expect(menu(page)).toBeVisible({ timeout: 10_000 });
    const cmds = await menu(page).locator('[data-testid="slash-menu-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-cmd")));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(c, String(c)).toMatch(/^\/con/);
    // No skill starts with "con" here (`vai`, `spenta`, and `recap` the CLI lists): that group is not drawn at all.  allow-italian: skill names
    await expect(groups(page).filter({ has: page.locator('[data-group="skills"]') })).toHaveCount(0);
    await expect(menu(page).locator('[role="group"][aria-label="Le tue skill"]')).toHaveCount(0);
  });

  test("on Topics' engine: Topics and Your skills, no engine group; on Codex: Topics only, no /compact nor skills", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "SKILL-01" });
    const nName = `slash-menu-native-${Date.now()}`;
    const native = await createTopic(request, nName, { provider: "topics" });
    made.push(native.id);
    await openChat(page, chatPage, request, native.id, nName);
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/");
    await expect(menu(page)).toBeVisible({ timeout: 10_000 });
    await expect(groups(page)).toHaveCount(2);
    await expect(groups(page).nth(1)).toHaveAttribute("aria-label", "Le tue skill");
    await expect(row(page, "/vai")).toHaveAttribute("data-turn", "true");
    await expect(row(page, "/spenta")).toHaveCount(0);
    await expect(row(page, "/compact")).toHaveCount(1);
    await page.keyboard.press("Escape");

    const cName = `slash-menu-codex-${Date.now()}`;
    const codex = await createTopic(request, cName, { provider: "codex" });
    made.push(codex.id);
    await openChat(page, chatPage, request, codex.id, cName);
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/");
    await expect(menu(page)).toBeVisible({ timeout: 10_000 });
    await expect(groups(page)).toHaveCount(1);
    await expect(groups(page).nth(0)).toHaveAttribute("aria-label", "Topics");
    await expect(row(page, "/compact")).toHaveCount(0);
    await expect(row(page, "/vai")).toHaveCount(0);
  });

  test("the keyboard crosses the groups without stopping on a header, and Enter on /status runs it at once", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMDUI-07" });
    const name = `slash-menu-keys-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    made.push(topic.id);
    await openChat(page, chatPage, request, topic.id, name);
    await send(chatPage, page, "ciao tastiera");
    await expect(chatPage.messageList).toContainText("got: ciao tastiera", { timeout: 40_000 });
    await chatPage.messageInput.fill("/");
    await expect(menu(page)).toBeVisible({ timeout: 10_000 });
    const topicsRows = await groups(page).nth(0).locator('[role="option"]').count();
    for (let i = 0; i < topicsRows; i++) await page.keyboard.press("ArrowDown");
    // The first row of the engine group is selected: the header was not a stop.
    const selected = menu(page).locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveAttribute("data-group", "engine");
    await expect(groups(page).nth(1).locator('[role="option"]').first()).toHaveAttribute("aria-selected", "true");

    await chatPage.messageInput.fill("/sta");
    await expect(row(page, "/status")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("chat-command-result")).toContainText("Stato della sessione", { timeout: 15_000 });
    await expect(chatPage.messageInput).toHaveValue("");
  });

  test("on a 390x844 phone the menu sits above the composer, not as a sheet, with rows of 44 px", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMDUI-07" });
    await page.setViewportSize({ width: 390, height: 844 });
    const name = `slash-menu-phone-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    made.push(topic.id);
    await openChat(page, chatPage, request, topic.id, name);
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/");
    await expect(menu(page)).toBeVisible({ timeout: 10_000 });
    const heights = await menu(page).locator('[data-testid="slash-menu-row"]').evaluateAll((els) => els.slice(0, 8).map((e) => e.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    const [m, f] = [await menu(page).boundingBox(), await chatPage.messageInput.boundingBox()];
    expect(m && f).toBeTruthy();
    expect(m!.y + m!.height).toBeLessThanOrEqual(f!.y + 1);
    // No scrim: the field is still the topmost thing at its own centre.
    const onField = await chatPage.messageInput.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(onField).toBe(true);
  });

  test("with «Reply» armed, /code-review reaches the CLI bare and the quote stays armed", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMDUI-07" });
    const name = `slash-menu-quote-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    made.push(topic.id);
    await openChat(page, chatPage, request, topic.id, name);
    await send(chatPage, page, "primo messaggio citabile");
    await expect(chatPage.messageList).toContainText("got: primo messaggio citabile", { timeout: 40_000 });
    const bubble = chatPage.messageList.getByText("got: primo messaggio citabile").first();
    await bubble.hover();
    await page.getByRole("button", { name: /Rispondi|Reply/ }).last().click();
    const quote = page.getByTestId("chat-reply-preview");
    await expect(quote).toBeVisible({ timeout: 10_000 });
    await send(chatPage, page, "/code-review");
    await expect.poll(() => received().at(-1) ?? "", { timeout: 30_000 }).toMatch(/^\/code-review/);
    await expect(quote).toBeVisible();
  });
});
