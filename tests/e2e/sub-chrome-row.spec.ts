/**
 * TWO STACKED CHROME ROWS, AND THE TAB STAYS CENTRED IN BOTH.
 *
 * A project window has two chrome rows: the app's, with the project TAB, and
 * below it the project's own, with its panes. The child row drops to
 * 34 = box(28) + ROW_INSET(6): the inset used to sit all at the tail (0
 * above, 6 below) to keep the gap between the two rows at SIX px, same as
 * every other pair of app cards — but that left the tab at the TOP edge of
 * its own row (card 18/11, "tabs stuck to the top edge"). Now the inset
 * splits (3 above, 3 below): the tab is centred like in any other row, and
 * the gap between the two rows grows from 6 to 9 (6 below the app row + 3
 * above this one).
 *
 * THIS FILE EXISTS FOR THE BLIND SPOTS, not for the number:
 *
 *  1. WITH THE COLUMN OPEN. The project sidebar header and the tab bar are
 *     two halves of the SAME row, but they are two different elements in two
 *     different files: the 34 has to be written by hand in both. If the
 *     header stays `h-10`, the card and the first sub-tab drift six pixels
 *     apart — and no other test notices, because they measure the bar
 *     collapsed.
 *  2. THE HEIGHT AND THE VARIABLE MUST SAY THE SAME NUMBER. `--chrome-bar-h`
 *     feeds both the panes' top inset and the gap above the conversation: a
 *     bar at 34 with the variable at 40 would open an empty strip under the
 *     bar, and `chrome-bar-overlay.spec.ts` does NOT see it — it measures the
 *     gap AGAINST the variable, so it is green at 34 just as at 40.
 *  3. THE TAB STAYS CENTRED EVEN SQUEEZED. Compact and square only change the
 *     width (`tabDensity`), never the height: the same check holds at any
 *     density.
 *
 * Nothing changes under 768px, and it is not caution: with touch the tab is
 * 36 and the row already leaves 2 on each side, symmetric — there is nothing
 * to split, and 36 in 34 would not fit. The test checks it as an INVARIANT
 * (the gap equals the air the row above leaves below its own ink), not as a
 * magic number.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { chooseInTabSheet } from "./helpers/tab-sheet";
import { waitForLayoutSettled } from "./helpers/layout";
import { canonicalTmpDir } from "./helpers/file-project";

hermetic(test);

/** Gap between the two rows: 6 (below the app row) + 3 (above the child row). */
const PASSO = 9;
/** `CHROME_ROW_SUB_H` = desktop box (28) + ROW_INSET (6). */
const SUB_H = 34;
/** Half of ROW_INSET (6): the child row's inset, above and below. */
const SUB_INSET = 3;

const PROJ = canonicalTmpDir("e2e-sub");

interface Misura {
  barre: { y: number; h: number; ink: { top: number; bottom: number } | null }[];
  barVar: string;
  /** La cima del contenuto della pane, per vedere se sotto la barra si apre un vuoto. */
  contenutoTop: number | null;
}

async function misura(page: Page): Promise<Misura> {
  return page.evaluate(() => {
    const arrotonda = (n: number) => Math.round(n * 10) / 10;
    // L'INCHIOSTRO di una riga: il rettangolo che racchiude le sue cose
    // dipinte — le tab e i comandi. È da qui che si misura uno stacco fra due
    // zone: la scatola della riga è più alta del suo contenuto, ed è proprio
    // quella differenza a raddoppiarsi quando le righe sono due.
    const inchiostro = (root: Element) => {
      const els = Array.from(root.querySelectorAll("button,[data-pane-id]"))
        .filter((e) => e.getBoundingClientRect().height > 10);
      if (!els.length) return null;
      const r = els.map((e) => e.getBoundingClientRect());
      return { top: arrotonda(Math.min(...r.map((x) => x.top))), bottom: arrotonda(Math.max(...r.map((x) => x.bottom))) };
    };
    const barre = Array.from(document.querySelectorAll(".pane-chrome-bar")).map((b) => {
      const r = b.getBoundingClientRect();
      return { y: arrotonda(r.y), h: arrotonda(r.height), ink: inchiostro(b) };
    });
    const win = document.querySelector('[data-testid="project-window"]')!;
    const barProject = win.querySelector(".pane-chrome-bar")!;
    const card = barProject.parentElement!;
    // La cella si riconosce dal RIENTRO EFFETTIVO, non dalla classe: la classe
    // e' un letterale Tailwind con parentesi e virgole dentro, e un selettore
    // d'attributo che la cerchi e' fragile per ragioni che non c'entrano con
    // cio' che stiamo misurando. Qui si cerca chi ha un padding-top pari
    // all'altezza della barra, che e' la definizione stessa di «cella rientrata».
    const hBarra = barProject.getBoundingClientRect().height;
    const cella = Array.from(card.querySelectorAll<HTMLElement>('*')).find((el) => {
      const pt = parseFloat(getComputedStyle(el).paddingTop);
      return Math.abs(pt - hBarra) < 0.5 && el.getBoundingClientRect().height > 40;
    }) ?? null;
    return {
      barre,
      barVar: getComputedStyle(card).getPropertyValue("--chrome-bar-h").trim(),
      contenutoTop: cella
        ? arrotonda(cella.getBoundingClientRect().top + parseFloat(getComputedStyle(cella).paddingTop))
        : null,
    };
  });
}

async function apri(page: Page, request: Parameters<typeof seedProjectPane>[0], suffisso: string) {
  await resetPaneStore(request, []);
  await seedProjectPane(request, PROJ + suffisso);
  await waitForPaneStoreQuiet(request);
  await goToApp(page);
  await page.waitForSelector('[data-testid="project-window"]', { timeout: 15000 });
  // Every measurement in this file is pixel geometry: it has to be taken when
  // the layout has stopped, not when a clock says it should have.
  await waitForLayoutSettled(page);
}

test.describe("La riga di chrome subordinata", () => {
  test("SUB-1: col mouse la tab figlia è centrata, chiusa e aperta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-02" });
    await page.setViewportSize({ width: 1400, height: 900 });
    await apri(page, request, "-a");

    // La colonna nasce APERTA: è lo stato in cui la testata della sidebar è
    // l'altra metà della riga, ed è il punto cieco che questo test copre.
    for (const stato of ["aperta", "chiusa"] as const) {
      const m = await misura(page);
      expect(m.barre.length, "servono due righe di chrome impilate").toBeGreaterThanOrEqual(2);
      const [sopra, sotto] = m.barre;
      expect(sopra.ink, "la riga dell'app non ha inchiostro").not.toBeNull();
      expect(sotto.ink, "la riga del progetto non ha inchiostro").not.toBeNull();

      expect(
        sotto.ink!.top - sopra.ink!.bottom,
        `${stato}: dall'inchiostro della riga sopra (${sopra.ink!.bottom}) a quello della riga sotto (${sotto.ink!.top})`,
      ).toBe(PASSO);

      // La riga figlia è più bassa, ed è ANCHE il segnale che è subordinata.
      expect(sotto.h, `${stato}: altezza della riga subordinata`).toBe(SUB_H);
      // The top air is HALF the inset: that is the whole point. The tab
      // stays centred in its own row, not stuck to the top edge.
      expect(sotto.ink!.top - sotto.y, `${stato}: aria in cima alla riga figlia`).toBe(SUB_INSET);
      // E LA VARIABILE DICE LO STESSO NUMERO DELLA SCATOLA. Confrontate fra
      // loro e non con la costante: è il loro DISACCORDO ad aprire una fascia
      // vuota sotto la barra, e `chrome-bar-overlay.spec.ts` non lo vede —
      // misura il varco CONTRO la variabile, quindi è verde a qualunque numero
      // purché i due sbaglino insieme.
      expect(m.barVar, `${stato}: --chrome-bar-h contro l'altezza vera`).toBe(`${sotto.h}px`);

      if (stato === "aperta") {
        await page.getByTestId("project-card").first().click();
        await waitForLayoutSettled(page);
      }
    }
  });

  test("SUB-2: una TAB vera cade centrata, e sotto la barra non resta un vuoto", async ({ page, request }) => {
    // I due test qui sopra misurano card e comandi, che stanno nello slot di
    // testa — FUORI dalla strip. La tab no: passa per la radice di PaneTabBar,
    // che nella riga subordinata perde `md:py-1`. È l'unico modo di accorgersi
    // se quella radice torna a sbordare.
    await page.setViewportSize({ width: 1400, height: 900 });
    await apri(page, request, "-b");

    await page.locator('[data-testid="pane-add-menu-trigger"]').last().click();
    // La chat e non il terminale: un terminale ha bisogno del bridge PTY, che
    // in questo ambiente non c'è — la voce si clicca e la tab non nasce.
    await page.getByRole("menuitem").filter({ hasText: /^Chat/ }).first().click();
    await expect(page.locator('[data-testid="project-window"] .pane-chrome-bar [data-pane-id]'))
      .toHaveCount(1, { timeout: 15000 });

    const t = await page.evaluate(() => {
      const win = document.querySelector('[data-testid="project-window"]')!;
      const bar = win.querySelector(".pane-chrome-bar")!;
      const rb = bar.getBoundingClientRect();
      const tab = win.querySelector(".pane-chrome-bar [data-pane-id]")!.getBoundingClientRect();
      const appTab = document.querySelector(".pane-chrome-bar [data-pane-id]")!.getBoundingClientRect();
      const arrotonda = (n: number) => Math.round(n * 10) / 10;
      return {
        sopra: arrotonda(tab.top - rb.top),
        sotto: arrotonda(rb.bottom - tab.bottom),
        dallAppTab: arrotonda(tab.top - appTab.bottom),
      };
    });
    expect(t.sopra, "la tab della riga figlia è centrata: metà incasso in cima").toBe(SUB_INSET);
    expect(t.sotto, "e l'altra metà in coda").toBe(SUB_INSET);
    expect(t.dallAppTab, "dalla tab dell'app alla tab del progetto passa il varco fra le righe").toBe(PASSO);
  });

  test("SUB-4: in uno SPLIT le barre della stessa riga sono allineate", async ({ page, request }) => {
    // La condizione era «la prima riga E il primo gruppo», cioè la sola barra
    // che ospita anche il blocco di testa. In uno split i gruppi della prima
    // riga stanno fianco a fianco alla STESSA quota: una barra da 34 accanto a
    // una da 40 è il disallineamento segnalato («in uno split progetto la
    // seconda tabbar esce disallineata», Attilio 09/08). Misurato prima del
    // rimedio: seconda barra h=40 e tab a y=46 contro h=34 e tab a y=40.
    await page.setViewportSize({ width: 1500, height: 950 });
    await apri(page, request, "-d");
    const win = page.locator('[data-testid="project-window"]');

    // Due pane, o non c'è niente da dividere.
    for (let i = 0; i < 2; i++) {
      await win.locator('[data-testid="pane-add-menu-trigger"]').last().click();
      await page.getByRole("menuitem").filter({ hasText: /^Chat/ }).first().click();
      await expect(win.locator(".pane-chrome-bar [data-pane-id]")).toHaveCount(i + 1, { timeout: 15000 });
    }
    await chooseInTabSheet(page, win.locator(".pane-chrome-bar [data-pane-id]").first(), "Dividi a destra");
    await expect(win.locator(".pane-chrome-bar")).toHaveCount(2, { timeout: 15000 });

    const barre = await win.locator(".pane-chrome-bar").evaluateAll((els) =>
      els.map((b) => {
        const r = b.getBoundingClientRect();
        const t = b.querySelector("[data-pane-id]")?.getBoundingClientRect();
        return { y: Math.round(r.y), h: Math.round(r.height), tabY: t ? Math.round(t.y) : null };
      }),
    );
    // Si confrontano FRA LORO, non con 34: quello che conta è che siano
    // uguali, qualunque numero il breakpoint imponga.
    const prima = barre[0];
    for (const b of barre.slice(1)) {
      expect(b.h, `altezze delle barre affiancate: ${JSON.stringify(barre)}`).toBe(prima.h);
      expect(b.y, "e partono dalla stessa quota").toBe(prima.y);
      expect(b.tabY, "e le loro tab cadono sulla stessa riga").toBe(prima.tabY);
    }
  });

  test("SUB-3: col dito la riga NON si stringe, e il varco resta quello della riga", async ({ page, request }) => {
    // 36 (tab touch) non sta in 34, e là l'aria è già 2 per lato: non c'è niente
    // da togliere. Si verifica l'INVARIANTE, non il numero: il varco fra le due
    // righe vale l'aria che la riga di sopra lascia sotto il proprio inchiostro.
    await page.setViewportSize({ width: 1400, height: 900 });
    await apri(page, request, "-c");
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForLayoutSettled(page);

    const m = await misura(page);
    const [sopra, sotto] = m.barre;
    expect(sotto.h, "col dito la riga subordinata resta piena").toBe(40);
    expect(m.barVar).toBe("40px");
    // Col dito NIENTE è cambiato: la riga figlia porta la sua aria in cima
    // esattamente come quella dell'app porta la sua. Il varco è la somma delle
    // due (2+2=4), e resta quello che era prima di questa tornata.
    expect(
      sotto.ink!.top - sotto.y,
      "col dito la riga figlia tiene la sua aria in cima",
    ).toBe(sopra.ink!.top - sopra.y);
  });
});
