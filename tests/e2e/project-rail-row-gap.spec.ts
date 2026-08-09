/**
 * LA FASCIA VUOTA SOTTO I COMANDI DEL PROGETTO — la barra contata due volte.
 *
 * «C'era però una riga extra a caso» (Attilio, 10/08). Non era una riga: era
 * `--chrome-bar-h` riservata DUE volte.
 *
 * `.pane-chrome-bar` è assoluta — non occupa spazio nel flusso — quindi chi le
 * sta sotto se lo fa da sé: le celle col rientro (`paneCellTopInset`) e la
 * conversazione col varco in cima. Poi in mezzo è arrivata la riga dei comandi
 * del progetto, che sta NEL flusso e si scavalca la barra da sola con
 * `mt-[var(--chrome-bar-h)]`. Da lì i lettori erano tre e il conto si faceva due
 * volte: la riga scendeva di 34, e la cella sotto di lei ne aggiungeva altri 34
 * per una barra che non aveva più niente sopra la testa.
 *
 * Misurato sulla finestra vera prima della correzione, in scuro a 1720×1410:
 * fine dei tre comandi a y=105, primo pixel di contenuto a y=144 — TRENTOTTO
 * pixel di niente.
 *
 * Qui si rimisura sul DOM, che è l'unico posto in cui l'errore era visibile: le
 * costanti erano tutte giuste ognuna per conto suo.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, rmSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-railgap-${Date.now()}`;

/** Il passo della colonna (`COLUMN_GAP`). Sotto i comandi non deve restare più
 *  di questo: la riga chiude già con il suo `pb-[6px]`. */
const COLUMN_GAP = 6;

test.describe("la riga dei comandi del progetto e ciò che le sta sotto", () => {
  test.beforeAll(() => { mkdirSync(PROJ, { recursive: true }); });
  test.afterAll(() => { rmSync(PROJ, { recursive: true, force: true }); });

  test("RAILGAP-1: fra i comandi e il contenuto non resta una fascia vuota", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // I comandi vivono solo a sidebar CHIUSA — è la forma in cui il difetto si
    // vedeva.
    await win.getByRole("button", { name: "Nascondi la barra" }).click();
    const riga = win.locator('[data-testid="project-rail-row"]');
    await expect(riga).toBeVisible({ timeout: 10000 });

    const misura = await win.evaluate((root) => {
      const riga = root.querySelector('[data-testid="project-rail-row"]') as HTMLElement;
      const barra = root.querySelector(".pane-chrome-bar") as HTMLElement;
      // Il primo elemento DIPINTO sotto la riga, qualunque esso sia: si cerca il
      // primo nodo il cui rettangolo comincia sotto la riga e ha area vera.
      const tutti = Array.from(root.querySelectorAll<HTMLElement>("*"));
      const gr = riga.getBoundingClientRect();
      let primo: { top: number; tag: string } | null = null;
      for (const el of tutti) {
        if (riga.contains(el) || el.contains(riga)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.top < gr.bottom - 0.5) continue;
        if (!primo || r.top < primo.top) primo = { top: r.top, tag: `${el.tagName}.${el.className?.toString().slice(0, 40)}` };
      }
      return {
        barraH: barra.getBoundingClientRect().height,
        rigaTop: gr.top,
        rigaBottom: gr.bottom,
        primoTop: primo?.top ?? null,
        primoTag: primo?.tag ?? null,
      };
    });

    expect(misura.primoTop, "niente di dipinto sotto la riga: la misura non regge").not.toBeNull();
    const varco = misura.primoTop! - misura.rigaBottom;
    expect(
      varco,
      `fra la riga dei comandi e «${misura.primoTag}» passano ${varco.toFixed(1)}px ` +
      `(barra ${misura.barraH.toFixed(1)}px). Se il varco ≈ l'altezza della barra, ` +
      `è di nuovo contata due volte — vedi CHROME_BAR_CONSUMED.`,
    ).toBeLessThanOrEqual(COLUMN_GAP + 1);

    // NON si asserisce anche il valore di `--chrome-bar-h` sotto la riga. Ci
    // ho provato: la riga e' PORTALATA nel suo slot, quindi nel DOM non ha il
    // fratello che ha nel layout, e ogni percorso per raggiungerlo passava per
    // la forma esatta dell'albero — cioe' si sarebbe rotto al primo
    // rimaneggiamento senza dire niente sulla proprieta'. Il varco misurato e'
    // gia' la prova end-to-end: se la barra torna a essere contata due volte,
    // ricompare qui.
  });

  test("RAILGAP-2: da APERTA, fra il trigger e «File» passa un passo solo", async ({ page, request }) => {
    // «Trigger aperto e File hanno distanza non conforme, forse perche' prima
    // c'era un bordo li'» (Attilio, 10/08). Non era un bordo: erano due passi
    // sommati. L'intestazione chiude con `md:pb-[6px]` — il passo PIENO — e la
    // card «File» sotto ci aggiungeva il suo mezzo (`my-[3px]` di SECTION_CARD),
    // facendo NOVE dove ogni altra coppia di card ne ha sei.
    //
    // La classe che azzera il mezzo passo della prima card (`sidebar-column`)
    // c'era nel drawer mobile e NON nella colonna desktop: la correzione era
    // stata applicata a meta', ed e' esattamente il tipo di cosa che una
    // costante non puo' dire — le due colonne montano le stesse card.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // Da APERTA: e' lo stato in cui il difetto si vede. La colonna e' aperta di
    // default, ma non si da' per scontato — si aspetta la sua card.
    const trigger = win.locator('[data-testid="project-sidebar"]').getByTestId("project-card");
    await expect(trigger).toBeVisible({ timeout: 10000 });
    const file = win.getByTestId("project-sidebar-files");
    await expect(file).toBeVisible({ timeout: 10000 });

    const t = (await trigger.boundingBox())!;
    const f = (await file.boundingBox())!;
    const varco = f.y - (t.y + t.height);
    expect(
      varco,
      `fra il trigger e «File» passano ${varco.toFixed(1)}px, atteso ${COLUMN_GAP}`,
    ).toBeLessThanOrEqual(COLUMN_GAP + 1);
  });
});
