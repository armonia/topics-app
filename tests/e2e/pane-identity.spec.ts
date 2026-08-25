import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, seedPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico del file: questa spec semina i propri topic e pane-store, ma
// parte dallo stato lasciato dalla spec precedente se non lo dichiara.
hermetic(test);

// PANE-IDENTITY — evidenza del task "una identità per pane + una pane rotta non
// abbatte la finestra".
//
// Scenario chiave (Fix 3): al livello App, un pane di chat il cui topic NON
// risolve più (topic cancellato, oppure una scrittura esterna con un UUID
// fasullo) sopravvive alla validazione ottimistica (`isUUIDLike` in
// usePanelLifecycle: un UUID senza record topic è tenuto come "sta ancora
// caricando") e arriva a StandaloneChatGroup come pane ATTIVO. Prima, con quel
// pane attivo, l'intero gruppo faceva `return null` → schermo bianco, solo la
// sidebar. Ora la tab strip resta viva e il body degrada a "Topic non trovato":
// puoi cambiare tab o chiudere quella rotta. La finestra non si abbatte più.
//
// Le invarianti "una identità = una tab" (dedup dell'ordine) e l'idempotenza di
// OPEN_PANE sono funzioni pure, provate deterministicamente dagli unit test
// (paneOrderReconcile.test.ts, panes.test.ts): qui filmiamo il comportamento di
// RENDER che nessun unit test può dimostrare.

// UUID valido per forma (passa UUID_RE) ma senza alcun topic dietro.
const BROKEN_UUID = "00000000-0000-4000-8000-000000000000";

test.describe("Pane identity — una pane rotta non abbatte la finestra", () => {
  const createdTopics: string[] = [];
  test.afterAll(async ({ request }) => {
    for (const id of createdTopics) await deleteTopic(request, id).catch(() => {});
  });

  test("un pane di chat con topic mancante (attivo) → tab strip viva + body d'errore, finestra viva", async ({

    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PANE-01" });
    // 1) Un topic REALE, così accanto al pane rotto c'è una tab sana su cui
    //    ripiegare (prova che la strip è viva e navigabile).
    const good = await createTopic(page.request, `PANE-IDENTITY-good-${Date.now()}`);
    createdTopics.push(good.id);

    // 2) Semina lo store con DUE pane app-level nel group:default — il topic
    //    buono e il pane rotto (UUID senza topic) — e mette il rotto a FUOCO,
    //    così è lui l'attivo al primo render (il caso che azzerava la finestra).
    await seedPaneStore(page.request, () => ({
      panes: {
        [good.id]: { id: good.id, type: "chat", title: "", topicId: good.id },
        [BROKEN_UUID]: { id: BROKEN_UUID, type: "chat", title: "", topicId: BROKEN_UUID },
      },
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: [good.id, BROKEN_UUID],
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
      focusedPaneId: BROKEN_UUID,
    }));

    await goToApp(page);

    // FINESTRA VIVA: la tab strip esiste. Con un pane rotto nel gruppo, prima
    // bastava che diventasse attivo per far fare `return null` all'INTERO
    // gruppo → schermo bianco. La strip qui è viva.
    const tabBar = page.getByTestId("panel-tab-bar").first();
    await expect(tabBar).toBeVisible();

    // Entrambe le identità hanno UNA tab ciascuna (una identità = una tab).
    await expect(page.getByTestId(`pane-tab-${good.id}`)).toBeVisible();
    await expect(page.getByTestId(`pane-tab-${BROKEN_UUID}`)).toBeVisible();

    // ATTIVA il pane ROTTO: è l'azione che azzerava la finestra. Ora il gruppo
    // NON sparisce — la strip resta, il body degrada a "Topic non trovato".
    await page.getByTestId(`pane-tab-${BROKEN_UUID}`).click();
    await expect(tabBar).toBeVisible(); // la finestra non si è abbattuta
    await expect(page.getByText("Topic non trovato")).toBeVisible(); // body d'errore, non un vuoto

    // NAVIGABILE: click sulla tab sana → il gruppo cambia body sotto la stessa
    // strip, senza rimontare. La finestra risponde, non è congelata. Il body
    // d'errore resta MONTATO (keep-alive) ma nascosto (display:none), quindi
    // non è più VISIBILE — non ne serve la rimozione dal DOM.
    await page.getByTestId(`pane-tab-${good.id}`).click();
    await expect(tabBar).toBeVisible();
    await expect(page.getByText("Topic non trovato")).not.toBeVisible();
  });
});
