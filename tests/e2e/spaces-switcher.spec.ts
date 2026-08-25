/**
 * spaces-switcher.spec.ts — i GRUPPI (Spazi), dopo che sono scesi nella sidebar.
 *
 * Il modello che questo file protegge: **un gruppo CONTIENE le sue tab**. Da
 * cui, in ordine:
 *   - il gruppo aperto ha la sua intestazione, e sotto — dentro di sé — la
 *     lista delle sue tab, non di tutte;
 *   - gli altri gruppi sono righe chiuse SOPRA quella intestazione: un elenco
 *     solo, nessuna barra separata da nessun'altra parte;
 *   - un gruppo si può spostare in una finestra sua (`?space=<id>`), e quella
 *     finestra mostra quel gruppo e basta.
 *
 * Superfici: `SpaceGroups` (data-testid="sidebar-groups", riga aperta
 * "space-row-active", righe chiuse "space-row", contenuto "space-content") e il
 * menu contestuale delle tab ("Sposta nel gruppo" / "Nuovo gruppo").
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

test.describe.serial("Gruppi (Spazi)", () => {
  let idA = "";
  let idB = "";

  test.beforeAll(async ({ request }) => {
    const a = await createTopic(request, "SPACE-A-" + Date.now());
    const b = await createTopic(request, "SPACE-B-" + Date.now());
    idA = a.id;
    idB = b.id;
  });

  test.afterAll(async ({ request }) => {
    if (idA) await deleteTopic(request, idA);
    if (idB) await deleteTopic(request, idB);
  });

  /** Due chat aperte a livello app, e la pagina caricata. */
  async function openTwoStandaloneTabs(page: Page) {
    // Reset PRISTINO del pane-store, `spaces` compresi. Questo gruppo è
    // `.serial`: al retry Playwright rigira dal primo test, che pretende zero
    // gruppi, e senza reset troverebbe quello creato dal giro precedente.
    await resetPaneStore(page.request, [idA, idB]);
    await Promise.all([
      page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [idA, idB] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [idA, idB], pinned: [idA, idB] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/grid-layout`, {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      }).catch(() => {}),
    ]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-pane-id="${idB}"]`).first()).toBeVisible({ timeout: 10000 });
  }

  /** Crea un gruppo spostandoci dentro la tab `paneId` (via menu contestuale). */
  async function moveTabToNewGroup(page: Page, paneId: string) {
    await page.locator(`[data-pane-id="${paneId}"]`).first().click({ button: "right" });
    const moveEntry = page.getByText("Sposta nel gruppo", { exact: true });
    await expect(moveEntry, "il menu della tab offre 'Sposta nel gruppo'").toBeVisible({ timeout: 3000 });
    await moveEntry.click();
    // Scoped al MENU per abitudine, non per necessità: dal 2026-08-05 questo è
    // l'UNICO "Nuovo gruppo" dell'app (l'invito in fondo alla sidebar creava un
    // gruppo vuoto ed è stato tolto).
    const newGroup = page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" });
    await expect(newGroup, "il sottomenu offre 'Nuovo gruppo'").toBeVisible({ timeout: 3000 });
    await newGroup.click();
  }

  test("SPACE-01: con un gruppo solo non si disegna niente (zero chrome)", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    // Nessuna intestazione sopra l'unica lista possibile, e nessuna riga di
    // gruppi da nessuna parte: il primo gruppo nasce dal menu di una tab.
    await expect(page.getByTestId("sidebar-groups")).toHaveCount(0);
    await expect(page.getByTestId("space-row")).toHaveCount(0);
    await expect(page.getByTestId("space-row-active")).toHaveCount(0);
  });

  test("SPACE-01b: un gruppo nasce SOLO portandoci una tab, non da un comando a vuoto", async ({ page }) => {
    // Il comando "Nuovo gruppo" in fondo alla sidebar creava un gruppo VUOTO e
    // ci portava dentro: uno stato che non serve a niente, con lo stesso nome
    // dell'azione che invece fa la cosa utile (crea il gruppo E ci mette la
    // tab). Tolto: qui si pretende che non torni.
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);
    await expect(page.getByTestId("space-add")).toHaveCount(0);
    // E l'unico "Nuovo gruppo" rimasto vive nel menu della tab, cioè non è
    // raggiungibile finché non apri quel menu.
    await expect(page.getByRole("button", { name: "Nuovo gruppo" })).toHaveCount(0);
  });

  test("SPACE-02: 'Sposta nel gruppo → Nuovo gruppo' crea il gruppo e ci porta la tab (senza cambiare vista)", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    // Ora i gruppi sono due: quello aperto (Principale, che contiene la lista)
    // e l'altro come riga chiusa sopra.
    await expect(page.getByTestId("space-row-active")).toContainText("Principale");
    await expect(page.getByTestId("space-row"), "l'altro gruppo è una riga chiusa").toHaveCount(1);

    // Semantica Arc: la finestra NON si sposta da sola — resta su Principale, e
    // la tab spostata esce dall'insieme visibile.
    await expect(
      page.locator(`[data-pane-id="${idA}"]`),
      "la tab spostata lascia l'insieme visibile",
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-pane-id="${idB}"]`).first(),
      "l'altra tab resta in Principale",
    ).toBeVisible();
  });

  test("SPACE-03: il chip commuta il gruppo, e la SIDEBAR segue (mostra le sue tab, non tutte)", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    const gruppo2 = page.getByTestId("space-row").filter({ hasText: "Gruppo 2" });
    await expect(gruppo2, "il nuovo gruppo si chiama 'Gruppo 2'").toBeVisible();

    // L'intestazione aperta dice quale gruppo stai guardando.
    await expect(page.getByTestId("space-row-active")).toContainText("Principale");

    await gruppo2.click();
    await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2");
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "la tab del gruppo attivo è visibile",
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(`[data-pane-id="${idB}"]`),
      "quella dell'altro gruppo no",
    ).toHaveCount(0);

    // E il CONTENUTO del gruppo è d'accordo: dentro di lui c'è la riga della
    // sua tab, non quella dell'altro. È la regressione che questo riordino
    // doveva chiudere — prima la lista era la stessa per tutti i gruppi.
    const sidebar = page.getByTestId("space-content");
    await expect(sidebar.getByText("SPACE-A-", { exact: false }).first()).toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText("SPACE-B-", { exact: false })).toHaveCount(0);
  });

  test("SPACE-04: da un altro gruppo, il ritorno a 'Principale' è ABILITATO", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).click();
    const tabAinSpace = page.locator(`[data-pane-id="${idA}"]`).first();
    await expect(tabAinSpace, "la tab A è visibile nel suo gruppo").toBeVisible({ timeout: 5000 });

    // Riapri il suo menu → "Sposta nel gruppo". La riga "Principale" deve essere
    // ABILITATA: senza, una tab spostata non tornerebbe più indietro (il bug era
    // che il sottomenu leggeva una pane ricostruita, senza `spaceId`).
    await tabAinSpace.click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    // Scoped al MENU: "Principale" è anche il nome sull'intestazione della sua
    // card, e senza lo scope il locator è ambiguo.
    const principaleEntry = page.getByRole("menu").getByRole("button", { name: "Principale", exact: true });
    await expect(principaleEntry, "la riga di ritorno c'è").toBeVisible({ timeout: 3000 });
    await expect(principaleEntry, "ed è cliccabile").toBeEnabled();
  });

  test("SPACE-05: 'Sposta in una finestra' apre la finestra DI QUEL GRUPPO", async ({ page }) => {
    // Fuori da Tauri il pop-out passa da `window.open`: lo si intercetta per
    // leggere la URL, che è il contratto vero (`?space=<id>`). L'init script va
    // installato PRIMA della navigazione.
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = ((url?: string | URL) => {
        w.__opened.push(String(url ?? ""));
        return null;
      }) as typeof window.open;
    });
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).click({ button: "right" });
    const detach = page.getByTestId("space-detach");
    await expect(detach, "il menu del gruppo offre di spostarlo in una finestra").toBeVisible({ timeout: 3000 });
    await detach.click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.length))
      .toBe(1);
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened[0], "e porta l'id del GRUPPO, non delle sue chat").toMatch(/[?&]space=space%3A/);
  });

  test("SPACE-05b: un gruppo che vive in un'altra finestra si VEDE, e il click la porta davanti", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    const spaceId = await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).getAttribute("data-space-id");
    expect(spaceId).toBeTruthy();

    // La presenza è WS-driven: si inietta la finestra-gruppo invece di aprirla
    // davvero (fuori da Tauri non esiste `window_focus_label`, e il punto qui è
    // il SEGNO sul chip + la rotta del click).
    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => ws.send(msg));
      ws.onMessage((msg) => server.send(msg));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "presence:windows",
          windows: [
            {
              windowId: "e2e-space-window",
              clientId: "e2e-c1",
              windowLabel: "space-e2e",
              detached: true,
              spaceId,
              topicIds: [idA],
              tabs: [{ id: idA, type: "chat" }],
            },
          ],
        }));
      }, 800);
    });
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const row = page.getByTestId("space-row").filter({ hasText: "Gruppo 2" });
    await expect(
      row.getByTestId("space-detached"),
      "la riga dice che quel gruppo vive in una finestra sua",
    ).toBeVisible({ timeout: 10000 });

    // Il click NON commuta qui: prova ad alzare quella finestra. Fuori da Tauri
    // non c'è, quindi il ripiego dichiarato (aprirlo qui) è ciò che si osserva —
    // ed è la prova che il ramo "porta davanti" è stato preso per primo.
    await row.click();
    await expect(page.getByTestId("space-row-active"), "il ripiego apre il gruppo qui").toContainText("Gruppo 2", { timeout: 5000 });
  });

  test("SPACE-06: una finestra `?space=` disegna QUEL gruppo, ma li mostra tutti — e può cambiare", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);

    // L'id del gruppo appena creato, letto dalla sua riga.
    const spaceId = await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).getAttribute("data-space-id");
    expect(spaceId, "la riga porta l'id del suo gruppo").toBeTruthy();

    await page.goto(`/?space=${encodeURIComponent(spaceId!)}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Disegna il SUO gruppo…
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "la finestra-gruppo mostra le tab del suo gruppo",
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator(`[data-pane-id="${idB}"]`),
      "e non quelle degli altri",
    ).toHaveCount(0);
    await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2");

    // …ma la sidebar li mostra TUTTI: una finestra che non sa dire cosa c'è
    // nelle altre è cieca.
    await expect(page.getByTestId("space-row").filter({ hasText: "Principale" })).toHaveCount(1);

    // E il gruppo che disegna può cambiare: la query È la sua identità, quindi
    // deve cambiare anche quella o il primo hydrate riporterebbe indietro tutto.
    await page.getByTestId("space-row").filter({ hasText: "Principale" }).click();
    await expect(page.getByTestId("space-row-active")).toContainText("Principale", { timeout: 5000 });
    await expect(page.locator(`[data-pane-id="${idB}"]`).first()).toBeVisible({ timeout: 5000 });
    expect(new URL(page.url()).searchParams.get("space"), "la query segue il gruppo").toBe("space:default");
  });

  test("SPACE-07: le card ci sono TUTTE, ognuna con le sue tab, e si aprono e chiudono da sole", async ({ page, request }) => {
    // La scena: A e C aperte, poi A se ne va in un gruppo nuovo. I due gruppi
    // devono coesistere — non alternarsi — ognuno con la sua tab dentro.
    const c = await createTopic(request, "SPACE-C-" + Date.now());
    try {
      await resetPaneStore(page.request, [idA, c.id]);
      await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [idA, c.id] } }).catch(() => {});
      await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: [idA, c.id], pinned: [] } }).catch(() => {});
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10000 });

      await moveTabToNewGroup(page, idA);

      // Due card, entrambe disegnate: quella attiva e l'altra.
      const active = page.getByTestId("space-card-active");
      const other = page.getByTestId("space-card");
      await expect(active).toHaveCount(1);
      await expect(other, "l'altro gruppo NON sparisce per far posto").toHaveCount(1);

      // E ciascuna tiene la SUA tab, non la lista di tutti.
      await expect(active.getByText("SPACE-C-", { exact: false }).first()).toBeVisible({ timeout: 5000 });
      await expect(active.getByText("SPACE-A-", { exact: false })).toHaveCount(0);
      await expect(other.getByText("SPACE-A-", { exact: false }).first()).toBeVisible({ timeout: 5000 });
      await expect(other.getByText("SPACE-C-", { exact: false })).toHaveCount(0);

      // L'accordion chiude SOLO la sua card (comportamento dei progetti).
      await other.locator("button[aria-expanded]").first().click();
      await expect(other.getByText("SPACE-A-", { exact: false })).toHaveCount(0);
      await expect(active.getByText("SPACE-C-", { exact: false }).first(), "l'altra resta aperta").toBeVisible();
    } finally {
      await deleteTopic(request, c.id).catch(() => {});
    }
  });

  test("SPACE-08: cliccare la tab di un altro gruppo ci porta la finestra (o non si vedrebbe)", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);
    await expect(page.getByTestId("space-row-active")).toContainText("Principale");

    // La riga di A vive nella card dell'altro gruppo. Aprirla senza commutare
    // farebbe apparire una pane dove non la guardi: la card intercetta il clic
    // in cattura e porta prima la finestra là.
    const other = page.getByTestId("space-card");
    await other.getByText("SPACE-A-", { exact: false }).first().click();

    await expect(page.getByTestId("space-row-active"), "il gruppo attivo segue la riga").toContainText("Gruppo 2", { timeout: 5000 });
    await expect(
      page.locator(`[data-pane-id="${idA}"]`).first(),
      "e la sua tab è davvero visibile",
    ).toBeVisible({ timeout: 5000 });
  });

  test("SPACE-09: un fissato sta SOPRA i gruppi, e una volta sola", async ({ page, request }) => {
    // Fissare vuol dire "questo lo voglio sempre a portata": sopra anche al
    // gruppo in cui vive. E una riga sola: la stessa riga in cima E dentro la
    // card sarebbe un doppione, non una scorciatoia.
    const c = await createTopic(request, "SPACE-C-" + Date.now());
    try {
      await resetPaneStore(page.request, [idA, c.id]);
      await page.request.put(`${BASE}/api/ui-state/sidebar-state`, {
        data: { pinnedItems: [c.id], viewMode: "timeline", showArchived: false },
      }).catch(() => {});
      await page.addInitScript((pinned: string) => {
        localStorage.setItem(
          "topics-sidebar-state",
          JSON.stringify({ pinnedItems: [pinned], viewMode: "timeline", showArchived: false }),
        );
      }, c.id);
      await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [idA, c.id] } }).catch(() => {});
      await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: [idA, c.id], pinned: [] } }).catch(() => {});
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10000 });

      await moveTabToNewGroup(page, idA);

      const pinned = page.getByTestId("sidebar-pinned-section");
      const groups = page.getByTestId("sidebar-groups");
      await expect(pinned.getByText("SPACE-C-", { exact: false }).first(), "il fissato c'è").toBeVisible({ timeout: 5000 });
      await expect(groups.getByText("SPACE-C-", { exact: false }), "e non anche dentro la card").toHaveCount(0);

      // Sopra, non in mezzo: il blocco dei fissati precede la prima card.
      const yPinned = (await pinned.boundingBox())!.y;
      const yFirstCard = (await page.getByTestId("space-card-active").first().boundingBox())!.y;
      expect(yPinned).toBeLessThan(yFirstCard);
    } finally {
      await page.request.put(`${BASE}/api/ui-state/sidebar-state`, {
        data: { pinnedItems: [], viewMode: "timeline", showArchived: false },
      }).catch(() => {});
      await deleteTopic(request, c.id).catch(() => {});
    }
  });

  test("SPACE-10: quando c'è un gruppo il lavoro sta dentro la sua cornice, e cambiando gruppo non si sposta", async ({ page }) => {
    await openTwoStandaloneTabs(page);
    // Senza gruppi non c'è cornice: non c'è niente da avvolgere.
    await expect(page.locator(".space-frame")).toHaveCount(0);

    await moveTabToNewGroup(page, idA);

    const frame = page.locator(".space-frame");
    await expect(frame, "la griglia ha la sua cornice").toHaveCount(1);
    await expect(frame).toHaveCSS("border-top-width", "1px");
    await expect(frame).toHaveCSS("border-top-left-radius", "10px");

    // La geometria NON cambia cambiando gruppo: una cornice che si muove
    // sfaserebbe le pane native (WKWebView), che non stanno nel DOM e restano
    // dove il layout le ha messe. L'ingresso è animato in sola opacità.
    const before = await frame.boundingBox();
    await page.getByTestId("space-row").first().click();
    await expect(page.getByTestId("space-row-active")).toContainText("Gruppo 2", { timeout: 5000 });
    const after = await frame.boundingBox();
    expect({ x: after!.x, y: after!.y, w: after!.width, h: after!.height })
      .toEqual({ x: before!.x, y: before!.y, w: before!.width, h: before!.height });
  });

  test("SPACE-11: la Board generale sta ferma in cima, sopra i fissati e fuori dai gruppi", async ({ page }) => {
    // La board è di tutti i progetti, non di un gruppo: anche quando la sua tab
    // vive dentro un gruppo, la riga resta il primo posto dove si guarda.
    await resetPaneStore(page.request, [idA, "__board__"]);
    await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [idA, "__board__"] } }).catch(() => {});
    await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: [idA, "__board__"], pinned: [] } }).catch(() => {});
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const board = page.getByTestId("sidebar-board-generale");
    await expect(board, "la riga della board c'è").toBeVisible({ timeout: 10000 });

    await moveTabToNewGroup(page, idA);

    const groups = page.getByTestId("sidebar-groups");
    await expect(groups).toHaveCount(1);
    await expect(groups.getByTestId("sidebar-board-generale"), "non finisce dentro una card").toHaveCount(0);
    const yBoard = (await board.boundingBox())!.y;
    const yGroups = (await groups.boundingBox())!.y;
    expect(yBoard).toBeLessThan(yGroups);
  });

  test("SPACE-12: trascinare una tab dentro la card di un altro gruppo la sposta lì", async ({ page, request }) => {
    // A e C aperte in Principale, poi A se ne va in Gruppo 2. C resta apposta:
    // svuotare il gruppo attivo lo farebbe cambiare da solo, e il test starebbe
    // misurando quello invece dello spostamento.
    const c = await createTopic(request, "SPACE-C-" + Date.now());
    try {
      await resetPaneStore(page.request, [idA, c.id]);
      await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: [idA, c.id] } }).catch(() => {});
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.locator(`[data-pane-id="${idA}"]`).first()).toBeVisible({ timeout: 10000 });
      await moveTabToNewGroup(page, idA);

      const card = (name: string) =>
        page.locator('[data-testid^="space-card"]').filter({ hasText: name });
      const principale = card("Principale");
      const gruppo2 = card("Gruppo 2");
      const rowC = principale.getByText("SPACE-C-", { exact: false }).first();
      await expect(rowC).toBeVisible({ timeout: 5000 });

      // Passi intermedi a mano: un `dragTo` in un colpo solo non fa partire il
      // drag HTML5 in Chromium (serve un movimento dopo il mousedown perché il
      // browser generi `dragstart`).
      const src = (await rowC.boundingBox())!;
      const dst = (await gruppo2.boundingBox())!;
      await page.mouse.move(src.x + 20, src.y + src.height / 2);
      await page.mouse.down();
      await page.mouse.move(src.x + 30, src.y + src.height / 2 + 6, { steps: 5 });
      await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 15 });
      await page.mouse.move(dst.x + dst.width / 2 + 2, dst.y + dst.height / 2 + 2, { steps: 5 });
      await page.mouse.up();

      // Ora C vive di là: la card di Gruppo 2 la contiene, Principale no.
      await expect(gruppo2.getByText("SPACE-C-", { exact: false }).first()).toBeVisible({ timeout: 5000 });
      await expect(principale.getByText("SPACE-C-", { exact: false })).toHaveCount(0);
    } finally {
      await deleteTopic(request, c.id).catch(() => {});
    }
  });

  test("SPACE-13: se il gruppo attivo vive in un'altra finestra, qui NON si disegna", async ({ page }) => {
    // Il difetto: staccato un gruppo, la finestra di partenza continuava a
    // disegnare le stesse tab — due finestre, la stessa griglia, gli stessi
    // terminali vivi in doppio.
    await openTwoStandaloneTabs(page);

    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => ws.send(msg));
      ws.onMessage((msg) => server.send(msg));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "presence:windows",
          windows: [
            {
              windowId: "e2e-space-window",
              clientId: "e2e-c1",
              windowLabel: "space-e2e",
              detached: true,
              spaceId: "space:default",
              topicIds: [idA, idB],
              tabs: [{ id: idA, type: "chat" }],
            },
          ],
        }));
      }, 600);
    });
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // La griglia lascia il posto al pannello, con le due sole azioni sensate.
    await expect(page.getByTestId("space-elsewhere")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("space-elsewhere-focus")).toBeVisible();
    await expect(page.getByTestId("space-elsewhere-reattach")).toBeVisible();
    await expect(
      page.locator(`[data-pane-id="${idA}"]`),
      "e le tab NON si disegnano due volte",
    ).toHaveCount(0);
  });

  test("SPACE-14: se c'è dove andare, la finestra si sposta invece di mostrare il cartello", async ({ page }) => {
    // Il cartello «è aperto in un'altra finestra» è l'ULTIMA risorsa: la cosa
    // giusta è portare davanti la finestra del gruppo e mettersi su un altro.
    await openTwoStandaloneTabs(page);
    await moveTabToNewGroup(page, idA);
    const spaceId = await page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).getAttribute("data-space-id");
    expect(spaceId).toBeTruthy();

    // La presenza dichiara che GRUPPO 2 vive in un'altra finestra, e si passa
    // lì: la finestra deve rimbalzare da sola su Principale.
    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => ws.send(msg));
      ws.onMessage((msg) => server.send(msg));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "presence:windows",
          windows: [
            {
              windowId: "e2e-space-window",
              clientId: "e2e-c1",
              windowLabel: "space-e2e",
              detached: true,
              spaceId,
              topicIds: [idA],
              tabs: [{ id: idA, type: "chat" }],
            },
          ],
        }));
      }, 500);
    });
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Nessun cartello: c'era dove andare.
    await expect(page.getByTestId("space-row-active"), "resta su Principale").toContainText("Principale", { timeout: 10000 });
    await expect(page.getByTestId("space-elsewhere")).toHaveCount(0);
    // E la card dell'altro dice che è in una finestra sua.
    await expect(
      page.getByTestId("space-row").filter({ hasText: "Gruppo 2" }).getByTestId("space-detached"),
    ).toBeVisible({ timeout: 5000 });
  });
});
