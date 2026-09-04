/**
 * UN PREDICATO SOLO — le quattro prove della fascia in cui i due si contraddicono.
 *
 * La shell si piega a una colonna a `innerWidth < 768`. Esisteva un SECONDO
 * predicato, «schermo piccolo» = `<768 || (touch && <1024)`, e due superfici che
 * decidono una questione di LAYOUT lo leggevano: la fila di comandi in fondo e
 * la disponibilita' degli split. Fra 768 e 1023 col dito i due rispondono
 * diverso, ed e' esattamente la larghezza di un iPhone messo in orizzontale e di
 * un iPad in verticale — cioe' non un caso di laboratorio.
 *
 * Le quattro prove, che erano rosse:
 *
 *  a) 844x390 col dito: la fila compariva SOPRA il layout desktop (sidebar a
 *     colonna fissa), e il suo interruttore era di sola andata — `boardInFront`
 *     si calcola col predicato di LAYOUT, li' falso, quindi ogni pressione
 *     prendeva il ramo «apri la board E chiudi la colonna». Due pressioni non
 *     riportavano la lista. Qui si accetta ENTRAMBE le uscite oneste: o la fila
 *     non c'e' dove il layout e' desktop, o c'e' e allora l'interruttore torna
 *     indietro. Cio' che non si accetta e' il tasto rotto.
 *
 *  b) 834x1194 col dito: `PanelGrid` monta davvero l'albero degli split coi
 *     divisori, e le tre voci che li governano sparivano dal menu della tab, dal
 *     menu «Topics» e dalla palette. Gli split ESISTONO e non li si poteva
 *     governare da nessuna parte.
 *
 *  c) 390x844 senza rete: «Connecting…/Reconnecting…/Offline» e «dati dalla
 *     cache» vivevano SOLO dentro il blocco desktop-only in fondo alla colonna.
 *     Sul telefono — il dispositivo che la rete la perde davvero — non esisteva
 *     nessun elemento che nominasse lo stato, e il pallino del titolo a cassetto
 *     chiuso e' largo zero.
 *
 *  d) la X della tab annunciava `Chiudi tab 7f3a1c22-…`, cioe' chiedeva con
 *     VoiceOver di distruggere qualcosa che non si puo' riconoscere. I gemelli
 *     nella sidebar dicono il nome della chat da sempre.
 *
 * `hasTouch` non e' un dettaglio di contorno: SENZA il segnale touch i due
 * predicati coincidono a ogni larghezza, e questa spec passerebbe verde
 * misurando un caso che non e' quello rotto.
 *
 * @covers LAYOUT-PRED-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const CHROME_BAR = '[data-testid="mobile-chrome-bar"]';
const BOARD_SWITCH = '[data-testid="mobile-chrome-board"]';
const TOPIC_LIST = '[data-testid="sidebar-topic-list"]';
const PANEL_CELL = "[data-panel-cell]";

/** Il nome della chat: si cerca DENTRO l'aria-label della X, e l'id NON ci deve
 *  stare. Due asserzioni opposte sulla stessa stringa, perche' «contiene il
 *  nome» da solo passerebbe anche se accanto ci fosse ancora l'uuid. */
const TOPIC_NAME = "Coerenza predicato";

let topicId: string | null = null;

test.beforeAll(async ({ request }) => {
  const topic = await createTopic(request, TOPIC_NAME);
  topicId = topic.id;
  await resetPaneStore(request, [topic.id]);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  if (topicId) await deleteTopic(request, topicId);
});

/** Quante colonne dice la shell che ci stanno: il predicato di layout, letto
 *  dalla stessa finestra che i componenti leggono. Serve a distinguere «la fila
 *  non c'e' perche' il layout e' desktop» (giusto) da «non c'e' e basta». */
async function layoutIsMobile(page: Page): Promise<boolean> {
  return page.evaluate(() => window.innerWidth < 768);
}

test.describe("Un predicato solo per «quante colonne»", () => {
  test.describe("a) un telefono in ORIZZONTALE, largo come un desktop stretto", () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

    test("la fila non si accende sopra il layout desktop, e se c'e' l'interruttore torna indietro", async ({ page }) => {
      await page.goto(BASE);
      await expect(page.locator(TOPIC_LIST)).toBeVisible({ timeout: 20_000 });

      // 844 e' sopra i 768: qui la shell disegna il layout desktop, e la fila
      // del telefono e' un pezzo di un'altra shell.
      expect(await layoutIsMobile(page)).toBe(false);

      const bar = page.locator(CHROME_BAR);
      const barCount = await bar.count();

      if (barCount === 0) {
        // La prima uscita onesta: dove il layout e' desktop la fila non esiste,
        // e con lei non esiste la banda che la radice le riservava — il 15% di
        // un viewport alto 390 tolto a una chat, per una barra che non c'e'.
        const reserved = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--mobile-chrome-h").trim(),
        );
        expect(reserved === "" || reserved === "0px").toBe(true);
        return;
      }

      // La seconda uscita onesta: la fila resta, ma allora e' un INTERRUTTORE.
      // Andata e ritorno, che e' la prova che i suoi due capi guardano lo
      // stesso schermo.
      const sw = page.locator(BOARD_SWITCH);
      await sw.tap();
      await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
      await sw.tap();
      await expect(page.locator(TOPIC_LIST)).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe("b) un tablet in VERTICALE, dove gli split si disegnano davvero", () => {
    test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });

    test("«Dividi a destra» c'e' nel menu della tab, e produce una seconda cella", async ({ page }) => {
      await page.goto(BASE);
      await expect(page.locator(TOPIC_LIST)).toBeVisible({ timeout: 20_000 });

      // 834 e' sopra i 768: la griglia e' quella con gli split.
      expect(await layoutIsMobile(page)).toBe(false);

      const tab = page.locator('[role="main"] [draggable="true"]').first();
      await expect(tab).toBeVisible({ timeout: 15_000 });
      await tab.click({ button: "right" });

      // IL ROSSO DI PRIMA: la voce spariva qui, su uno schermo dove lo split
      // funziona. Il menu «Topics» e la palette la perdevano dalla stessa
      // sorgente, quindi non restava nessuna strada.
      const splitRight = page.getByText("Dividi a destra", { exact: true });
      await expect(splitRight).toBeVisible({ timeout: 5000 });
      await splitRight.click();

      // E la voce non e' decorativa: le celle diventano due.
      await expect
        .poll(() => page.locator(PANEL_CELL).count(), { timeout: 15_000 })
        .toBeGreaterThan(1);
    });
  });

  test.describe("c) un telefono che perde la rete", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("un elemento a schermo nomina lo stato, senza aprire il cassetto", async ({ page, context }) => {
      await page.goto(BASE);
      await expect(page.locator(CHROME_BAR)).toBeVisible({ timeout: 20_000 });

      // Qui la shell E' a una colonna: e' il caso del telefono vero.
      expect(await layoutIsMobile(page)).toBe(true);

      await context.setOffline(true);
      try {
        // Non si apre NIENTE: nessun menu, nessun cassetto. La frase deve
        // essere gia' a schermo, perche' un allarme che chiede un gesto per
        // farsi vedere non e' un allarme.
        const band = page.getByTestId("mobile-transport-band");
        await expect(band).toBeVisible({ timeout: 30_000 });
        await expect(band).toContainText(/Offline|Reconnecting…|Connecting…/, { timeout: 30_000 });
      } finally {
        await context.setOffline(false);
      }
    });
  });

  test.describe("d) la X della tab, annunciata", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("l'aria-label porta il nome della chat e NON l'id interno", async ({ page }) => {
      await page.goto(BASE);
      const close = page.getByTestId("pane-tab-close").first();
      await expect(close).toHaveCount(1, { timeout: 20_000 });

      const label = (await close.getAttribute("aria-label")) ?? "";
      expect(label).toContain(TOPIC_NAME);
      // L'id NON ci sta piu': senza questa meta', un'etichetta che aggiungesse
      // il nome ACCANTO all'uuid passerebbe verde dicendo il falso.
      expect(label).not.toContain(topicId ?? "@@@");
      expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    });
  });
});
