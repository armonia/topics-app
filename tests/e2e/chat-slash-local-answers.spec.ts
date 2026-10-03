import { expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installCompactCli, installQueueTurnsCli, installSlowTurnCli } from "./helpers/fake-claude-cli";

// Hermetic: this file starts from the globalSetup baseline, not from the state
// the previous specs left. See fixtures/hermetic.ts.
hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 120_000 });

/**
 * Commands the composer answers ITSELF, and what reaches the CLI.
 *
 * Measured on 2026-10-03 against Claude Code 2.1.288, which Topics drives with
 * `--print`: `/resume`, `/export`, `/permissions`, `/vim` and fifteen more are
 * refused by the CLI in that mode («/X isn't available in this environment.»),
 * in English, shown as the agent's reply. Bare `/browser`, `/model`, `/effort`
 * and `/context`, picked from the menu, reached the model or printed a second
 * answer next to the control that already gives it. `/new` and `/reset` are
 * the CLI's aliases of `/clear` and reached it unconfirmed.
 *
 * WHAT THE FAKE CLI CAN AND CANNOT SHOW. `installQueueTurnsCli` writes down
 * every message the CLI is handed, so «nothing reached the CLI» is a fact read
 * from its log, and the last test proves the log is written at all. It cannot
 * show the real CLI's refusal text or what the model answers: those were
 * measured on the real CLI (see `claudeCliCommands.fixture.json`), and
 * `slashCommandRouting.test.ts` holds the lists to them.
 *
 * @covers CMD-06, CMD-07, CMD-09
 */

const LOG = join(E2E_HOME, "fake-cli-slash-local.jsonl");
interface LogLine { event: string; text?: string }
const received = (): string[] => existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine).filter((l) => l.event === "received").map((l) => l.text ?? "")
  : [];

/** The answer of a typed command: the strip that carries the dismiss button. */
const result = (page: Page) => page.getByTestId("chat-command-result");

async function type(chatPage: ChatPage, page: Page, text: string) {
  await chatPage.messageInput.click();
  await chatPage.messageInput.fill(text);
  // Dismiss the `/` menu so Enter sends instead of picking a row.
  await page.keyboard.press("Escape");
  await chatPage.messageInput.press("Enter");
}

test.describe("slash commands answered in the composer", () => {
  let topicId: string;
  let topicName: string;
  let uninstall: (() => void) | null = null;

  test.beforeAll(async ({ request }) => {
    rmSync(LOG, { force: true });
    uninstall = installQueueTurnsCli(LOG);
    topicName = `slash-local-${Date.now()}`;
    topicId = (await createTopic(request, topicName, { provider: "claude-code" })).id;
  });

  test.afterAll(async ({ request }) => {
    uninstall?.();
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ page, request, chatPage }) => {
    await resetPaneStore(request, [topicId]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  });

  test("/resume is answered here, names what to use instead, and reaches nobody", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-06" });
    await type(chatPage, page, "/resume");
    await expect(result(page)).toContainText(/riprendono da sole/i, { timeout: 10_000 });
    await expect(result(page)).toContainText(/Riprova/);
    // Not in the menu any more: typing `/res` offers nothing named resume.
    await chatPage.messageInput.fill("/res");
    await expect(page.getByRole("option", { name: /\/resume/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(received(), "the CLI was handed a command it can only refuse").toEqual([]);
  });

  test("/permissions and /vim name where to go in Topics; nothing reaches the CLI", async ({ page, chatPage }) => {
    await type(chatPage, page, "/permissions");
    await expect(result(page)).toContainText(/autonomia/i, { timeout: 10_000 });
    await type(chatPage, page, "/vim");
    await expect(result(page)).toContainText(/\/vim è un comando del terminale/i, { timeout: 10_000 });
    expect(received()).toEqual([]);
  });

  test("/browser picked from the menu answers with its usage instead of reaching the model", async ({ page, chatPage }) => {
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/brow");
    await page.getByRole("option", { name: /\/browser/ }).click();
    await expect(chatPage.messageInput).toHaveValue("/browser ");
    await chatPage.messageInput.press("Enter");
    await expect(result(page)).toContainText("/browser <indirizzo>", { timeout: 10_000 });
    expect(received()).toEqual([]);
  });

  test("bare /model opens the model picker, bare /effort the effort panel, /context the inspector", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-06" });
    await type(chatPage, page, "/model");
    await expect(page.getByTestId("provider-model-picker")).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 });
    await page.keyboard.press("Escape");

    await type(chatPage, page, "/effort");
    await expect(page.getByTestId("chat-session-config")).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
    await page.keyboard.press("Escape");

    await type(chatPage, page, "/context");
    await expect(page.getByTestId("chat-input-context-ring")).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
    await expect(page.locator('[data-popover="context-inspector"]').getByTestId("context-inspector")).toBeVisible({ timeout: 20_000 });
    // No second answer in a banner next to the control that gives it.
    await expect(result(page)).toHaveCount(0);
    expect(received()).toEqual([]);
  });

  test("/new asks the /clear confirmation and sends nothing to the CLI", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-09" });
    await type(chatPage, page, "/new");
    const dialog = page.getByRole("dialog").filter({ hasText: "Svuoto la conversazione?" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: /Annulla/ }).click();
    await expect(dialog).toHaveCount(0);
    expect(received()).toEqual([]);
  });

  test("/help stays until it is closed, instead of vanishing after five seconds", async ({ page, chatPage }) => {
    await type(chatPage, page, "/help");
    await expect(result(page)).toContainText("/compact", { timeout: 10_000 });
    const shownAt = Date.now();
    // The defect IS a clock: one five-second timer closed every result. The
    // wait is the condition under test, so it is a poll on elapsed time and
    // not a fixed sleep.
    await expect.poll(() => Date.now() - shownAt, { timeout: 10_000, intervals: [500] }).toBeGreaterThan(6_000);
    await expect(result(page)).toBeVisible();
    await result(page).getByRole("button", { name: "Chiudi il messaggio del comando" }).click();
    await expect(result(page)).toHaveCount(0);
  });

  test("/project answers in Italian, without emoji", async ({ page, chatPage }) => {
    await type(chatPage, page, "/project");
    await expect(result(page)).toContainText("Nessun progetto collegato a questa chat.", { timeout: 10_000 });
    await expect(result(page)).not.toContainText(/No project bound|📍|🗂/);
  });

  test("/rewind on a chat without a project says why, in one sentence", async ({ page, chatPage }) => {
    await type(chatPage, page, "/rewind");
    await expect(result(page)).toContainText("questa chat non ha una cartella di progetto", { timeout: 10_000 });
    await expect(result(page)).not.toContainText("Impostazioni");
    await expect(result(page)).not.toContainText("not bound");
  });

  test("an ordinary message still reaches the CLI: the log above is not empty by construction", async ({ page, chatPage }) => {
    await type(chatPage, page, "messaggio-normale-di-controllo");
    await expect.poll(() => received().some((t) => t.includes("messaggio-normale-di-controllo")), { timeout: 30_000 }).toBe(true);
  });
});

test.describe("/compact says how it went", () => {
  test("on an empty session the failure the CLI gives is the result, and the notice closes", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-06" });
    const uninstall = installCompactCli();
    const name = `compact-fails-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    try {
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
      await type(chatPage, page, "/compact");
      // Asserted INSIDE the result strip: the CLI's message also lands in the
      // thread as an agent bubble, so a page-wide match proves nothing.
      await expect(result(page)).toHaveAttribute("data-result-type", "error", { timeout: 30_000 });
      await expect(result(page)).toContainText("Not enough messages to compact.");
      await expect(result(page)).not.toContainText(/in corso/);
    } finally {
      uninstall();
      await deleteTopic(request, topic.id);
    }
  });
});

test.describe("attaching during a turn", () => {
  test("«Allega un file» is enabled while the agent answers, and the file is attached", async ({ page, request, chatPage }) => {
    const uninstall = installSlowTurnCli();
    const name = `attach-turn-${Date.now()}`;
    const topic = await createTopic(request, name, { provider: "claude-code" });
    try {
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
      await chatPage.messageInput.fill("SLOW:20:allega");
      await chatPage.messageInput.press("Enter");
      await expect(page.getByText(/allega-02/)).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("composer-add-menu").click();
      const attach = page.getByTestId("composer-attach-file");
      await expect(attach).toBeEnabled();
      const chooser = page.waitForEvent("filechooser");
      await attach.click();
      await (await chooser).setFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("ciao") });
      await expect(page.getByTestId("composer-attachment")).toHaveCount(1);
      // Still the same turn: the attachment was taken while it ran.
      await expect(page.getByText(/allega-20/)).toHaveCount(0);
    } finally {
      uninstall();
      await deleteTopic(request, topic.id);
    }
  });
});
