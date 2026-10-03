import { expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installReplayCli } from "./helpers/fake-claude-cli";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 150_000 });

/**
 * THE ANSWER OF A COMMAND IS A CARD OF THE PANE, NOT A MESSAGE (CMDUI-04).
 *
 * Every text is looked for INSIDE the card, the container of the
 * `chat.command.dismiss` button: «Not enough messages to compact.» used to be
 * in the page already, as a bubble of the agent, so a page-wide match proves
 * nothing. The CLI is `fake-claude-replay.ts`, which answers `/output-style`
 * and `/compact` with the lines Claude Code 2.1.288 wrote.
 *
 * @covers CMDUI-04
 */

const LOG = join(E2E_HOME, "fake-cli-command-answer.jsonl");
const received = (): string[] => (existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; text?: string })
    .filter((l) => l.event === "received").map((l) => l.text ?? "")
  : []);
/** The card: the container of the dismiss button. */
const card = (page: Page) => page.getByRole("button", { name: "Chiudi il messaggio del comando" }).locator("xpath=ancestor::*[@data-testid='chat-command-result'][1]");

async function send(chatPage: ChatPage, page: Page, text: string) {
  await chatPage.messageInput.click();
  await chatPage.messageInput.fill(text);
  await page.keyboard.press("Escape");
  await chatPage.messageInput.press("Enter");
}

test.describe("the card of a command's answer", () => {
  let uninstall: (() => void) | null = null;
  const made: string[] = [];

  test.beforeAll(() => {
    rmSync(LOG, { force: true });
    uninstall = installReplayCli(LOG);
  });
  test.afterAll(async ({ request }) => {
    uninstall?.();
    for (const id of made) await deleteTopic(request, id);
  });

  async function chat(page: Page, request: import("@playwright/test").APIRequestContext, chatPage: ChatPage, label: string) {
    const name = `${label}-${Date.now()}`;
    const t = await createTopic(request, name, { provider: "claude-code" });
    made.push(t.id);
    await resetPaneStore(request, [t.id]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    return t;
  }

  test("/status: model, effort and autonomy, no chat name; it stays past six seconds; X closes it, so does the next message; a reload has none and the CLI never saw it", async ({ page, request, chatPage }) => {
    const t = await chat(page, request, chatPage, "answer-status");
    await patchTopic(request, t.id, { model: "opus", effort: "high", autonomyLevel: "ask" } as never);
    await send(chatPage, page, "/status");
    await expect(card(page)).toContainText("Stato della sessione", { timeout: 15_000 });
    for (const label of ["Modello", "Effort", "Autonomia"]) await expect(card(page).getByTestId("chat-command-rows")).toContainText(label);
    await expect(card(page)).not.toContainText(t.name);
    const shownAt = Date.now();
    await expect.poll(() => Date.now() - shownAt, { timeout: 10_000, intervals: [500] }).toBeGreaterThan(6_000);
    await expect(card(page)).toBeVisible();
    await card(page).getByRole("button", { name: "Chiudi il messaggio del comando" }).click();
    await expect(page.getByTestId("chat-command-result")).toHaveCount(0);

    await send(chatPage, page, "/status");
    await expect(card(page)).toBeVisible({ timeout: 15_000 });
    await send(chatPage, page, "dopo lo stato");
    await expect(page.getByTestId("chat-command-result")).toHaveCount(0);
    await expect(chatPage.messageList).toContainText("got: dopo lo stato", { timeout: 40_000 });
    await page.reload();
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 30_000 });
    await expect(page.getByTestId("chat-command-result")).toHaveCount(0);
    expect(received().some((r) => r.includes("Stato della sessione") || r.includes("/status"))).toBe(false);
  });

  test("/output-style: the CLI's own words are in the card, not a message of the agent, not after a reload", async ({ page, request, chatPage }) => {
    await chat(page, request, chatPage, "answer-style");
    await send(chatPage, page, "/output-style");
    await expect(card(page)).toContainText("Output style:", { timeout: 40_000 });
    await expect(card(page)).toContainText("/output-style");
    // Not in the thread: the only copy is the card's.
    await expect(chatPage.messageList.getByText(/Output style:/)).toHaveCount(0);
    await page.reload();
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 30_000 });
    await expect(page.getByTestId("chat-command-result")).toHaveCount(0);
    await expect(page.getByText(/Output style:/)).toHaveCount(0);
  });

  test("/compact: «in progress», then the CLI's failure read inside the card, and no agent message repeats it", async ({ page, request, chatPage }) => {
    await chat(page, request, chatPage, "answer-compact");
    await send(chatPage, page, "/compact");
    await expect(card(page)).toHaveAttribute("data-result-type", "error", { timeout: 40_000 });
    await expect(card(page)).toContainText("Not enough messages to compact.");
    await expect(card(page)).not.toContainText(/in corso/);
    await expect(page.getByText("Not enough messages to compact.")).toHaveCount(1);
  });
});
