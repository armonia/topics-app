/**
 * Il ciclo di vita di un GRUPPO nella sidebar: si vede, tiene le sue tab, si
 * stacca in una finestra sua — e quando resta senza niente dentro SPARISCE.
 *
 * `spaces-switcher.spec.ts` sorveglia la nascita e la resa (le card ci sono
 * tutte, ognuna con le sue tab, il detach, il drop). Qui si sorveglia il
 * RITORNO, che è la metà che mancava: una tab che esce dal gruppo, e il gruppo
 * che, svuotato, smette di essere una scatola.
 *
 * LA REGOLA: **si mostra come gruppo finché tiene almeno una tab.** Un gruppo
 * non contiene niente di suo — è l'insieme delle tab che ci hai messo — quindi
 * a zero non è un contenitore: è una riga che occupa la colonna e chiede di
 * essere sciolta a mano. Con zero gruppi PIENI la sidebar torna la lista di
 * sempre, senza una scatola in più.
 *
 * Due eccezioni, ed entrambe hanno una ragione operativa: il PRINCIPALE resta
 * sempre (è la casa delle tab senza gruppo, ed è il bersaglio su cui si lascia
 * cadere una tab per tirarla FUORI da un gruppo), e un gruppo che vive in una
 * finestra sua resta anche a zero (è da lì che lo si porta davanti).
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

test.describe.serial("Gruppi — ciclo di vita nella sidebar", () => {
  // Più larga del default della suite: questo file è anche la CLIP di consegna,
  // e l'anteprima di un task viene resa a 268px — oltre 0.70 di rapporto la
  // card taglia invece di rimpicciolire. 1440×760 → 0.528.
  test.use({ viewport: { width: 1440, height: 760 } });

  let idA = "";
  let idB = "";
  let idC = "";
  let idD = "";

  test.beforeAll(async ({ request }) => {
    idA = (await createTopic(request, "GRP-A-" + Date.now())).id;
    idB = (await createTopic(request, "GRP-B-" + Date.now())).id;
    idC = (await createTopic(request, "GRP-C-" + Date.now())).id;
    idD = (await createTopic(request, "GRP-D-" + Date.now())).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [idA, idB, idC, idD]) if (id) await deleteTopic(request, id).catch(() => {});
  });

  async function scena(page: Page, aperte: string[]) {
    await resetPaneStore(page.request, aperte);
    await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: aperte } }).catch(() => {});
    await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: aperte, pinned: [] } }).catch(() => {});
    await page.request.put(`${BASE}/api/ui-state/grid-layout`, {
      data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
    }).catch(() => {});
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${aperte[0]}"]`).first()).toBeVisible({ timeout: 10000 });
  }

  /** Crea un gruppo spostandoci dentro la tab `paneId` (menu della tab). */
  async function moveTabToNewGroup(page: Page, paneId: string) {
    await page.locator(`[data-pane-id="${paneId}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    await page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" }).click();
  }

  /** Sposta la tab `paneId` nel gruppo già esistente di nome `nome`. */
  async function moveTabToGroup(page: Page, paneId: string, nome: string) {
    await page.locator(`[data-pane-id="${paneId}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    await page.getByRole("menu").getByRole("button", { name: nome }).click();
  }

  const card = (page: Page, nome: string) =>
    page.locator('[data-testid^="space-card"]').filter({ hasText: nome });

  /** Trascina `src` sopra `dst` col mouse vero: in Chromium l'HTML5 DnD non
   *  parte da un `dragTo` in un colpo solo — serve un movimento dopo il down. */
  async function trascina(page: Page, src: ReturnType<Page["locator"]>, dst: ReturnType<Page["locator"]>) {
    const s = (await src.boundingBox())!;
    const d = (await dst.boundingBox())!;
    await page.mouse.move(s.x + 20, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + 30, s.y + s.height / 2 + 6, { steps: 5 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 15 });
    await page.mouse.move(d.x + d.width / 2 + 2, d.y + d.height / 2 + 2, { steps: 5 });
    await page.mouse.up();
  }

  test("GRPLIFE-01: un gruppo con tre tab si vede, dice quante ne tiene, si apre e si stacca", async ({ page }) => {
    // Il pop-out fuori da Tauri passa da `window.open`: lo si intercetta per
    // leggere la URL, che è il contratto (`?space=<id>`).
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = ((url?: string | URL) => {
        w.__opened.push(String(url ?? ""));
        return null;
      }) as typeof window.open;
    });
    await scena(page, [idA, idB, idC, idD]);

    // A, B, C nel gruppo; D resta in Principale (svuotare il gruppo attivo lo
    // farebbe cambiare da solo, e misureremmo quello).
    await moveTabToNewGroup(page, idA);
    await moveTabToGroup(page, idB, "Gruppo 2");
    await moveTabToGroup(page, idC, "Gruppo 2");

    const gruppo = card(page, "Gruppo 2");
    await expect(gruppo, "il gruppo è una card nella sidebar").toHaveCount(1);
    await expect(
      gruppo.getByText("3", { exact: true }),
      "e dice quante tab tiene",
    ).toBeVisible({ timeout: 5000 });

    // Dentro ci sono le SUE tre tab, e non quella di Principale.
    for (const nome of ["GRP-A-", "GRP-B-", "GRP-C-"]) {
      await expect(gruppo.getByText(nome, { exact: false }).first()).toBeVisible({ timeout: 5000 });
    }
    await expect(gruppo.getByText("GRP-D-", { exact: false })).toHaveCount(0);

    // E si chiude e si riapre per conto suo, come i progetti.
    const freccia = gruppo.getByRole("button", { name: /^(Apri|Chiudi) Gruppo 2$/ }).first();
    await freccia.click();
    await expect(gruppo.getByText("GRP-A-", { exact: false })).toHaveCount(0, { timeout: 5000 });
    await freccia.click();
    await expect(gruppo.getByText("GRP-A-", { exact: false }).first()).toBeVisible({ timeout: 5000 });

    // E si stacca da qui: la finestra che nasce porta l'id del GRUPPO.
    await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).click({ button: "right" });
    await page.getByTestId("space-detach").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
      .toEqual([expect.stringMatching(/[?&]space=space%3A/)]);
  });

  test("GRPLIFE-02: una tab trascinata sul Principale esce dal gruppo, e il gruppo svuotato sparisce", async ({ page }) => {
    await scena(page, [idA, idB]);
    // Com'era la colonna PRIMA che esistesse un gruppo: è il riferimento di
    // «identica a oggi, nessuna scatola in più».
    const prima = await page.getByTestId("sidebar-timeline").innerText();
    await moveTabToNewGroup(page, idA);
    const gruppo = card(page, "Gruppo 2");
    const principale = card(page, "Principale");
    const rigaA = gruppo.getByText("GRP-A-", { exact: false }).first();
    await expect(rigaA, "la tab spostata vive nella card del gruppo").toBeVisible({ timeout: 5000 });

    await trascina(page, rigaA, principale);

    await expect(
      card(page, "Gruppo 2"),
      "il gruppo rimasto senza niente dentro non è più una scatola",
    ).toHaveCount(0, { timeout: 5000 });
    // Ed era l'unico gruppo pieno: senza, cade tutta l'impalcatura — niente
    // card, nemmeno quella del Principale, e la tab tirata fuori torna una voce
    // a sé nella lista di sempre.
    await expect(page.getByTestId("sidebar-groups")).toHaveCount(0);
    await expect(
      page.locator('[aria-label="Topics sidebar"]').getByText("GRP-A-", { exact: false }).first(),
      "tirata fuori, la tab è una voce a sé",
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "e torna visibile fra le tab, col Principale davanti",
    ).toBeVisible({ timeout: 5000 });
    // Riga per riga, è la colonna di partenza: il gruppo è passato di qui senza
    // lasciare un contenitore vuoto dietro di sé.
    await expect
      .poll(() => page.getByTestId("sidebar-timeline").innerText(), { timeout: 5000 })
      .toBe(prima);
  });

  test("GRPLIFE-03: chiusa l'ultima tab del gruppo, la scatola sparisce e la finestra torna a casa", async ({ page }) => {
    await scena(page, [idA, idB]);
    await moveTabToNewGroup(page, idA);
    await expect(page.getByTestId("sidebar-groups"), "col gruppo, le card ci sono").toHaveCount(1);

    // Si va nel gruppo e si chiude la sua unica tab.
    await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).click();
    await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 5000 });
    // Dal menu della tab, non dalla X: quella si scopre al passaggio del mouse
    // e sotto il cursore è la tab a prendersi il clic.
    await page.locator(`[data-pane-id="${idA}"]`).first().click({ button: "right" });
    await page.getByRole("menu").getByText("Chiudi ora", { exact: true }).click();

    await expect(page.getByTestId("sidebar-groups"), "niente gruppi pieni, niente scatole").toHaveCount(0, { timeout: 5000 });
    // E la finestra non resta prigioniera del gruppo svuotato — sarebbe il
    // vicolo cieco: griglia vuota e nemmeno una card da cliccare per uscirne,
    // proprio perché la sua non c'è più. Si torna al Principale, dove la tab
    // rimasta si vede.
    await expect(page.locator(`[data-pane-id="${idB}"]`).first()).toBeVisible({ timeout: 5000 });
  });

  test("GRPLIFE-04: sotto i 768px la card del gruppo c'è, tiene le sue tab e non deborda", async ({ page }) => {
    // Il gruppo si compone da schermo largo — sul telefono la griglia è
    // appiattita in una barra di tab e il menu della tab non è quel gesto — e
    // poi si guarda la stessa colonna a 390px: è la situazione vera, uno che si
    // alza dalla scrivania e continua dal telefono.
    await scena(page, [idA, idB, idC]);
    await moveTabToNewGroup(page, idA);
    await moveTabToGroup(page, idB, "Gruppo 2");
    await expect(card(page, "Gruppo 2")).toHaveCount(1);

    // Sul telefono la colonna è un CASSETTO che ricorda dov'eri: senza questa
    // riga riparte chiuso (`width: 0`) e ogni misura esce zero, cioè il test
    // passerebbe confrontando due nulla.
    await page.addInitScript(() => {
      try { localStorage.setItem("topics-mobile-drawer-collapsed", "0"); } catch { /* private mode */ }
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    const colonna = page.getByTestId("sidebar-topic-list");
    await expect(colonna).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () => (await colonna.boundingBox())?.width ?? 0, { timeout: 15000 })
      .toBeGreaterThan(200);

    const gruppo = card(page, "Gruppo 2");
    await expect(gruppo, "il gruppo si vede anche a 390px").toBeVisible({ timeout: 10000 });
    await expect(gruppo.getByText("GRP-A-", { exact: false }).first()).toBeVisible({ timeout: 5000 });

    // Niente scorrimento orizzontale: la card sta dentro la colonna.
    const deborda = await colonna.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(deborda, "la card non allarga la colonna").toBeLessThanOrEqual(1);
  });
});
