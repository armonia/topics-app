import { expect, type Page } from "@playwright/test";
import { test, ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * `/model`, `/effort` and `/reasoning` used to hard-400 on a claude-code topic
 * ("… not supported by this provider") — the reason "the slash commands don't
 * work". They now persist the per-topic spawn flag (model/effort) and respawn,
 * and /reasoning points to /effort instead of erroring.
 *
 * @covers CMD-06
 */
test.describe("Chat slash commands (claude-code)", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `slash-cc-${Date.now()}`;
    const t = await createTopic(request, topicName, { provider: "claude-code" });
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `chatPage.messageInput` è STRICT: le pane lasciate aperte dai file
  // precedenti (pane-store unico per la suite seriale) la farebbero risolvere a
  // più composer. Reset al solo topic claude-code di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function runCmd(chatPage: ChatPage, page: Page, cmd: string) {
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill(cmd);
    await page.keyboard.press("Escape"); // dismiss the slash-suggestion popup
    await chatPage.messageInput.press("Enter");
  }

  test("/model, /effort, /reasoning no longer 400 on claude-code", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // /model — persists the per-topic model, no 400.
    await runCmd(chatPage, page, "/model claude-opus-4-8");
    await expect(page.locator("body")).toContainText(/Modello impostato: claude-opus-4-8/i, { timeout: 10_000 });
    await expect(page.locator("body")).not.toContainText(/not supported by this provider/i);

    // Niente attesa dell'auto-dismiss del banner (erano 2 x 5,5 s = 11 s): ogni
    // comando ha un messaggio DIVERSO, quindi il banner precedente non puo'
    // far passare l'asserzione successiva.
    // /effort — persists the per-topic effort tier, no 400.
    await runCmd(chatPage, page, "/effort high");
    await expect(page.locator("body")).toContainText(/Effort impostato: high/i, { timeout: 10_000 });

    // /reasoning — redirects to /effort instead of the old hard 400. Si asserisce
    // il messaggio ESATTO del server (topics.ts: "Su claude-code il ragionamento
    // si regola con l'effort…"), non un generico /effort/i: quello matchava anche
    // il banner "Effort impostato" appena mostrato, ed e' proprio la ragione per
    // cui serviva la pausa. L'asserzione specifica non ha quel problema.
    await runCmd(chatPage, page, "/reasoning");
    await expect(page.locator("body")).toContainText(
      /il ragionamento si regola con l'effort/i,
      { timeout: 10_000 },
    );
    await expect(page.locator("body")).not.toContainText(/not supported by this provider/i);
  });
});
