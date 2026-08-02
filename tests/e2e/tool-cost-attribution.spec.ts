import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * Attribuzione del consumo alla SINGOLA azione (tool call), non solo al turno.
 *
 * Ogni riga di tool mostra il costo della chiamata al modello che ha DECISO
 * quell'azione, accanto alla durata; il gruppo (≥3 azioni) somma i costi delle
 * sue azioni. Questa spec è anche l'EVIDENZA di review (screenshot).
 */
test.describe.serial("Costo per-azione sulle righe di tool", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Tool Cost " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("ogni riga mostra il SUO costo, il gruppo somma le sue azioni", async ({ page, request }) => {
    const base = Date.now() - 120_000;
    const u = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "leggi un file grosso e poi un ls veloce",
      timestamp: new Date(base - 2000).toISOString(),
    });
    // Due azioni sotto la soglia di raggruppamento → righe singole, con il
    // costo di ciascuna: un Read costoso (contesto grande) vs una Bash da niente.
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "Fatto: il Read pesava, l'ls no.",
      timestamp: new Date(base).toISOString(),
      toolCalls: [
        {
          id: "tc-read-big",
          name: "Read",
          args: { file_path: "/repo/huge-generated-bundle.js" },
          status: "success",
          result: "…(50k righe)…",
          startedAt: base,
          endedAt: base + 1_400,
          costCents: 3.2, // $0.032 — la chiamata che ha deciso questo Read
          tokens: 48_000,
        },
        {
          id: "tc-bash-tiny",
          name: "Bash",
          args: { command: "ls" },
          status: "success",
          result: "a.ts\nb.ts",
          startedAt: base + 1_500,
          endedAt: base + 1_640,
          costCents: 0.12, // $0.0012 — due righe, pesa nulla
          tokens: 1_200,
        },
      ],
    });

    // Turno agentico da ≥3 azioni → una riga di gruppo che SOMMA i costi.
    const u2 = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "fai il giro completo",
      timestamp: new Date(base + 3000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u2.id,
      content: "Giro completo.",
      timestamp: new Date(base + 4000).toISOString(),
      toolCalls: [
        { id: "grp-r1", name: "Read", args: { file_path: "/a.ts" }, status: "success", result: "aaa", startedAt: base + 5_000, endedAt: base + 7_000, costCents: 1.5, tokens: 12_000 },
        { id: "grp-r2", name: "Read", args: { file_path: "/b.ts" }, status: "success", result: "bbb", startedAt: base + 7_500, endedAt: base + 9_000, costCents: 1.1, tokens: 9_000 },
        { id: "grp-e1", name: "Edit", args: { file_path: "/a.ts" }, status: "success", startedAt: base + 9_500, endedAt: base + 12_000, costCents: 2.4, tokens: 20_000 },
      ],
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    // Righe singole: ciascuna col suo costo attribuito.
    const readRow = page.locator('[data-testid="tool-call-row-tc-read-big"]');
    const bashRow = page.locator('[data-testid="tool-call-row-tc-bash-tiny"]');
    await expect(readRow).toBeVisible({ timeout: 10_000 });
    await expect(readRow.locator('[data-testid="tool-cost"]')).toContainText("$0.03");
    await expect(bashRow.locator('[data-testid="tool-cost"]')).toContainText("$0.0012");

    // Gruppo: UNA riga col costo sommato delle sue azioni (1.5+1.1+2.4 = $0.05).
    const group = page.locator('[data-testid="tool-group-row"]');
    await expect(group).toBeVisible();
    await expect(group).toContainText("3 azioni");
    await expect(group.locator('[data-testid="tool-group-cost"]')).toContainText("$0.05");

    // Evidenza di review, allegata al risultato del test.
    //
    // Non un percorso assoluto: c'era `/Users/zorahrel/.topics/media/…` cablato,
    // che su qualunque altro checkout — e su CI — scrive in una cartella che non
    // esiste, quindi o fallisce o sparisce. `test.info().attach` mette lo scatto
    // nel report HTML e negli artifact, dove chi rivede lo trova davvero.
    await test.info().attach("tool-cost-attribution", {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
  });
});
