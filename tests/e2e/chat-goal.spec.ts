import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * L'obiettivo della chat (3.4).
 *
 * Quello che serve provare non è che una barra si accende: è che l'obiettivo
 * ARRIVA AL MODELLO e ci resta. Da qui i controlli che contano — il blocco
 * `synthetic:goal` dentro l'envelope che il server assembla davvero, e la
 * sopravvivenza a un reload (lo stato non vive nel componente).
 *
 * Il turno lean — quello di ripresa del dispatcher, dove il blocco serve di
 * più — è coperto da `server/context/assemble.test.ts`: qui servirebbe un
 * dispatch vero solo per ripetere la stessa asserzione.
 *
 * Ogni test si semina lo stato che gli serve: dipendere dal test precedente
 * renderebbe il secondo rosso solo perché è rosso il primo.
 *
 * @covers CTX-GOAL-01
 * @covers CTX-GOAL-03
 */
test.describe("Obiettivo della chat", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `goal-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // `chatPage.messageInput` è STRICT (nessun .first()): basta una pane chat
  // lasciata aperta da un'altra spec per far fallire tutto il file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function openChat(page: Page, chatPage: { messageInput: Locator }) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  async function runCommand(page: Page, input: Locator, text: string) {
    await input.click();
    await input.fill(text);
    // Chiude il popup dei suggerimenti: altrimenti Enter sceglie una voce di
    // menu invece di inviare il comando.
    await page.keyboard.press("Escape");
    await input.press("Enter");
  }

  /** I blocchi di sistema che il server manderebbe al modello adesso. */
  async function systemBlocks(request: import("@playwright/test").APIRequestContext) {
    const res = await request.get(`/api/topics/${topicId}/context-preview`);
    expect(res.ok()).toBe(true);
    const { envelope } = await res.json();
    return envelope.systemBlocks as Array<{ id: string; content: string; enabled: boolean; countInBudget: boolean }>;
  }

  test("/goal dichiara, entra nell'envelope e sopravvive al reload", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CTX-GOAL-01" });
    await openChat(page, chatPage);
    await runCommand(page, chatPage.messageInput, "/goal Sistemare il login");

    const bar = page.getByTestId("goal-bar");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText("Sistemare il login");

    // Il dato, non il pixel: il server lo ha scritto.
    const stored = await (await request.get(`/api/topics/${topicId}/goal`)).json();
    expect(stored.goal?.content).toBe("Sistemare il login");
    expect(stored.goal?.status).toBe("active");
    expect(stored.goal?.createdBy).toBe("human");

    // E il modello lo vede: il blocco è nell'envelope che il server assembla.
    const block = (await systemBlocks(request)).find((b) => b.id === "synthetic:goal");
    expect(block, "l'envelope deve contenere synthetic:goal").toBeTruthy();
    expect(block!.content).toContain("Sistemare il login");
    expect(block!.enabled).toBe(true);
    expect(block!.countInBudget).toBe(true);

    // Non vive nel componente: dopo un reload è ancora lì.
    await page.reload();
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect(page.getByTestId("goal-bar")).toContainText("Sistemare il login", { timeout: 10_000 });
  });

  test("i passi del piano arrivano nella barra senza reload e nel contesto", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CTX-GOAL-01" });
    const created = await (
      await request.put(`/api/topics/${topicId}/goal`, { data: { content: "Portare a verde la suite" } })
    ).json();
    const goalId = created.goal.id as string;

    await openChat(page, chatPage);
    const bar = page.getByTestId("goal-bar");
    await expect(bar).toContainText("Portare a verde la suite", { timeout: 10_000 });

    // La stessa rotta che usa il ramo `plan` di ACP.
    await request.put(`/api/goals/${goalId}/steps`, {
      data: {
        steps: [
          { content: "Leggere il router", status: "completed" },
          { content: "Scrivere il test", status: "in_progress" },
        ],
      },
    });

    // Il contatore arriva dal broadcast `goal:updated`: nessun reload.
    await expect(bar).toContainText("1/2", { timeout: 10_000 });
    await bar.getByRole("button").first().click();
    await expect(bar).toContainText("Leggere il router");

    const block = (await systemBlocks(request)).find((b) => b.id === "synthetic:goal");
    expect(block!.content).toContain("[x] Leggere il router");
    expect(block!.content).toContain("[~] Scrivere il test");
  });

  test("il goal dell'agente: etichetta, passi in linea, progresso, e l'umano se lo prende", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CTX-GOAL-03" });
    // The same write the `set_goal` tool does: an AGENT goal.
    const created = await (
      await request.put(`/api/topics/${topicId}/goal`, {
        data: { content: "Portare a verde la suite", createdBy: "agent" },
      })
    ).json();
    const goalId = created.goal.id as string;
    // And the same one `update_goal_steps` does.
    await request.put(`/api/goals/${goalId}/steps`, {
      data: {
        steps: [
          { content: "Leggere il router dei goal", status: "completed" },
          { content: "Scrivere le rotte per session key", status: "completed" },
          { content: "Cablare i due tool MCP", status: "in_progress" },
          { content: "Passare i sei cancelli", status: "pending" },
        ],
      },
    });

    await openChat(page, chatPage);
    const bar = page.getByTestId("goal-bar");
    await expect(bar).toContainText("Portare a verde la suite", { timeout: 10_000 });
    // WHO it comes from is visible: a proposal, not the person's decision.
    await expect(bar.getByTestId("goal-by-agent")).toBeVisible();
    // The steps of an agent goal open by themselves: nobody asked for that
    // goal, and what there is to read is what it is doing.
    await expect(bar).toContainText("2/4");
    await expect(bar).toContainText("Cablare i due tool MCP");
    await expect(bar).toContainText("Passare i sei cancelli");

    if (process.env.E2E_EVIDENCE) {
      await bar.screenshot({ path: test.info().outputPath("goal-bar-agent.png") });
    }

    // The person adopts it: same goal, same steps, now theirs.
    await bar.getByTestId("goal-promote").click();
    await expect(bar.getByTestId("goal-by-agent")).toHaveCount(0, { timeout: 10_000 });
    const after = await (await request.get(`/api/topics/${topicId}/goal`)).json();
    expect(after.goal.id).toBe(goalId);
    expect(after.goal.createdBy).toBe("human");
    expect(after.goal.steps.length).toBe(4);
  });

  test("/goal fatto chiude: via la barra, via il blocco dal contesto", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CTX-GOAL-01" });
    await request.put(`/api/topics/${topicId}/goal`, { data: { content: "Chiudere questo giro" } });

    await openChat(page, chatPage);
    await expect(page.getByTestId("goal-bar")).toBeVisible({ timeout: 10_000 });

    await runCommand(page, chatPage.messageInput, "/goal fatto");
    await expect(page.getByTestId("goal-bar")).toHaveCount(0, { timeout: 10_000 });

    const after = await (await request.get(`/api/topics/${topicId}/goal`)).json();
    expect(after.goal).toBeNull();
    // Chiuso, non cancellato: lo storico resta leggibile, e «fatto» non è
    // «lasciato perdere».
    expect(after.history[0].content).toBe("Chiudere questo giro");
    expect(after.history[0].status).toBe("achieved");

    expect((await systemBlocks(request)).map((b) => b.id)).not.toContain("synthetic:goal");
  });
});
