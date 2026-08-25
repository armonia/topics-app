/**
 * In split view il badge sparisce solo dalla cella che stai GUARDANDO.
 *
 * Il bug. La soppressione del badge sulla tab attiva leggeva `isSelected`, che
 * vuol dire «è l'attiva DEL SUO GRUPPO» — e in split ogni gruppo ha la sua.
 * Risultato: due celle affiancate, tu ne guardi una, e il badge spariva anche
 * dall'altra. La riga di sidebar dello stesso soggetto continuava a mostrarlo,
 * quindi le due superfici dicevano cose diverse sulla stessa chat: esattamente
 * l'invariante che `topicAttentionCount` e `rollupProjectAttention` esistono per
 * difendere («a chat's badge can never differ between the two surfaces»).
 *
 * Perché serve un E2E e non uno unit test: la regola vive inline nel JSX di
 * `PaneTabBar` e dipende da tre valori che solo il layout vero mette insieme
 * (quale gruppo ha il fuoco, quale pane è attiva in ciascuno, se la finestra è a
 * fuoco). In isolamento ognuno dei tre è corretto.
 *
 * L'altra metà — «senza fuoco esplicito, l'attiva È quella che guardi» — è il
 * motivo per cui il fix non può essere solo `isSelected → isFullyActive`:
 * `focusedGroupId` è null finché non clicchi, e presa alla lettera quella
 * versione faceva ricomparire il badge su TUTTE le tab attive all'avvio.
 * TAB-BADGE-07 lo prova sulla superficie a gruppo unico; qui si prova che la
 * convenzione regge anche con due celle.
 *
 * @covers TAB-BADGE-07
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { splitViaContextMenu } from "./helpers/layout";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
} from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

test.describe("Split view: il badge sparisce solo da ciò che guardi", () => {
  let sinistra: { id: string; name: string };
  let destra: { id: string; name: string };

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    sinistra = await createTopic(request, `split-sinistra-${stamp}`);
    destra = await createTopic(request, `split-destra-${stamp}`);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [sinistra, destra]) {
      if (t?.id) await deleteTopic(request, t.id).catch(() => {});
    }
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [sinistra.id, destra.id]);
  });

  test("la cella NON guardata tiene il suo badge", async ({ page }) => {
    const ws = await interceptWebSocket(page);
    await goToApp(page);

    const tabSinistra = page.locator(`[role="tab"][data-pane-id="${sinistra.id}"]`);
    const tabDestra = page.locator(`[role="tab"][data-pane-id="${destra.id}"]`);
    await expect(tabSinistra).toBeVisible({ timeout: 20000 });
    await expect(tabDestra).toBeVisible({ timeout: 20000 });

    // Due celle affiancate: la seconda tab finisce nella cella nuova.
    await splitViaContextMenu(page, "Dividi a destra", 1);

    // Si guarda la cella di SINISTRA.
    await tabSinistra.click();
    await expect(tabSinistra).toHaveAttribute("data-active", "true", { timeout: 10000 });

    // La chat di DESTRA — attiva nella sua cella, ma non quella che guardi —
    // riceve dei non letti.
    ws.send({ type: "unread:updated", topicId: destra.id, unreadCount: 3 });

    // Deve TENERE il badge: e' attiva nel suo gruppo, non sotto i tuoi occhi.
    const badgeDestra = tabDestra.locator("span.rounded-full").filter({ hasText: /^\d+$/ });
    await expect(badgeDestra).toHaveCount(1, { timeout: 15000 });
    await expect(badgeDestra).toHaveText("3");

    // E la riga di sidebar dello stesso soggetto dice lo STESSO numero: e' la
    // divergenza fra superfici il difetto vero, non il badge in se'.
    const rigaSidebar = page
      .locator('[aria-label="Topics sidebar"] [role="treeitem"]')
      .filter({ hasText: destra.name });
    await expect(rigaSidebar.locator("span").filter({ hasText: /^3$/ }).first())
      .toBeVisible({ timeout: 10000 });

    // Ora la guardi: il badge cade, e cade SOLO il suo.
    ws.send({ type: "unread:updated", topicId: sinistra.id, unreadCount: 2 });
    await tabDestra.click();
    await expect(badgeDestra).toHaveCount(0, { timeout: 15000 });
    const badgeSinistra = tabSinistra.locator("span.rounded-full").filter({ hasText: /^\d+$/ });
    await expect(badgeSinistra).toHaveCount(1, { timeout: 10000 });
  });
});
