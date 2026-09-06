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
  * @covers RAILGAP-01
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { initGitRepo } from "./helpers/file-project";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

hermetic(test);

// The REAL path, not `/tmp/...` written by hand: the app names a project by
// the directory it resolves to (`canonicalProjectPath`, 2026-09-02), and on
// macOS `/tmp` is a link to `/private/tmp`, so a pane seeded as `/tmp/x` is
// drawn as `/private/tmp/x` and a locator on the literal finds nothing. On
// Linux the two coincide, which is why the runner never saw it. Same form as
// `sidebar-label-gutter.spec.ts` and `tab-focus-reload.spec.ts`.
const PROJ = join(realpathSync(tmpdir()), `e2e-railgap-${Date.now()}`);

/** Il passo della colonna (`COLUMN_GAP`). Sotto i comandi non deve restare più
 *  di questo: la riga chiude già con il suo `pb-[6px]`. */
const COLUMN_GAP = 6;

test.describe("la riga dei comandi del progetto e ciò che le sta sotto", () => {
  test.beforeAll(() => {
    mkdirSync(PROJ, { recursive: true });
    // A REAL REPOSITORY WITH AN UNCOMMITTED CHANGE. Since fb8d1f27e
    // (PROJECT-12) the git command exists only when git has something to say:
    // in an empty folder the card holds TWO commands, not three, and RAILGAP-1,
    // which counts the three commands inside the card, fell on a folder that
    // had never been a repository. What the spec measures is the complete card,
    // so the state it prepares is the one in which the card is complete.
    writeFileSync(`${PROJ}/README.md`, "uno\n");
    initGitRepo(PROJ, "primo");
    writeFileSync(`${PROJ}/README.md`, "uno\ndue\n");
  });
  test.afterAll(() => { rmSync(PROJ, { recursive: true, force: true }); });

  test("RAILGAP-1: i comandi non si portano dietro nessuna riga", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "RAILGAP-01" });
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // I comandi vivono solo a sidebar CHIUSA.
    await win.getByRole("button", { name: "Nascondi la barra" }).click();

    // THERE IS NO ROW ANY MORE, since 30/08. The three commands live INSIDE the
    // title card, in line with the tabs, so the band this spec watched cannot
    // exist: nothing produces it. The original defect - `--chrome-bar-h`
    // reserved twice - could only come back by putting a row into the flow
    // under the bar again, and that is what is measured here.
    await expect(
      win.locator('[data-testid="project-rail-row"]'),
      "e' tornata una riga dei comandi sotto la barra: e' la forma in cui l'altezza della barra veniva contata due volte",
    ).toHaveCount(0);

    const card = win.locator('[data-testid="project-card-shell"]');
    await expect(card).toBeVisible({ timeout: 10000 });

    // The third command is the git one, and it is LIVE (PROJECT-12): it mounts
    // when the status of the repository seeded above arrives, not with the
    // card. Wait for it, so the count below measures a card that is complete
    // and not one still waiting for git.
    await expect.poll(
      () => card.locator('[data-testid="project-rail-button"]').count(),
      { timeout: 15000, message: "il comando git non e' arrivato nella card: il repo seminato ha una modifica, il suo stato deve mostrarlo" },
    ).toBeGreaterThanOrEqual(3);

    // And the three commands sit INSIDE that card, not beside it and not under it.
    const inside = await card.evaluate((el) => ({
      comandi: el.querySelectorAll('[data-testid="project-rail-button"]').length,
      alti: Array.from(el.querySelectorAll<HTMLElement>('button')).map((b) => Math.round(b.getBoundingClientRect().top)),
      cardTop: Math.round(el.getBoundingClientRect().top),
      cardBottom: Math.round(el.getBoundingClientRect().bottom),
    }));
    expect(inside.comandi, "i comandi non sono dentro la card del titolo").toBeGreaterThanOrEqual(3);
    // One row: every button of the card starts at the same height, inside the
    // card's box. If anyone stacks them again, this falls.
    for (const t of inside.alti) {
      expect(t, `un comando esce dalla card (${t} contro ${inside.cardTop}-${inside.cardBottom})`).toBeGreaterThanOrEqual(inside.cardTop - 1);
      expect(t).toBeLessThanOrEqual(inside.cardBottom);
    }

    // NON si asserisce anche il valore di `--chrome-bar-h` sotto la riga. Ci
    // ho provato: la riga e' PORTALATA nel suo slot, quindi nel DOM non ha il
    // fratello che ha nel layout, e ogni percorso per raggiungerlo passava per
    // la forma esatta dell'albero — cioe' si sarebbe rotto al primo
    // rimaneggiamento senza dire niente sulla proprieta'. Il varco misurato e'
    // gia' la prova end-to-end: se la barra torna a essere contata due volte,
    // ricompare qui.
  });

  test("RAILGAP-2: da APERTA, fra il trigger e «File» passa un passo solo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "RAILGAP-01" });
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

  test("RAILGAP-3: da APERTA il contenuto NON risale sotto la barra di vetro", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "RAILGAP-01" });
    // La contro-prova di RAILGAP-1, ed e' il difetto che la sua correzione ha
    // introdotto: `CHROME_BAR_CONSUMED` azzera il rientro delle celle perche' la
    // riga dei comandi ha gia' scavalcato la barra — ma quella riga esiste solo
    // da sidebar CHIUSA, mentre il suo SLOT (un div in un `useMemo`) esiste
    // sempre. Gatando sull'esistenza dello slot invece che sul suo contenuto, il
    // reset scattava anche da aperta: il contenuto risaliva sotto la barra e ci
    // si leggeva attraverso, sfocato. «Ora vedo uno sfondo blur sotto le
    // tabbar» (Attilio, 10/08).
    //
    // Si misura la cosa vera: il primo pixel della pane non puo' stare piu' in
    // alto del bordo basso della barra. E' l'unica formulazione che non dipende
    // da COME lo spazio viene riservato.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });
    await expect(win.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 10000 });
    // Da aperta la riga dei comandi non deve proprio esserci.
    await expect(win.locator('[data-testid="project-rail-row"]')).toHaveCount(0);

    // Si misura la COSA CHE SI VEDE — niente inseguimento della cella o della
    // variabile: ci ho provato con due selettori e nessuno dei due agganciava,
    // e il test passava a vuoto finché non gli ho messo il controllo di
    // esistenza. La proprietà vera è una sola e non dipende da COME lo spazio
    // viene riservato: sotto la barra non dipinge niente.
    const misura = await win.evaluate((root) => {
      const barra = root.querySelector(".pane-chrome-bar") as HTMLElement;
      const b = barra.getBoundingClientRect();
      let primo: { top: number; tag: string } | null = null;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (barra.contains(el) || el.contains(barra)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 8) continue;
        // Solo ciò che sta nella colonna della PANE, a destra della sidebar:
        // la sidebar di progetto comincia in cima per conto suo.
        if (r.left < b.left + 8) continue;
        if (r.top < b.top - 0.5) continue;
        if (!primo || r.top < primo.top) {
          primo = { top: r.top, tag: `${el.tagName}.${el.className?.toString().slice(0, 40)}` };
        }
      }
      return { barraTop: b.top, barraBottom: b.bottom, primoTop: primo?.top ?? null, primoTag: primo?.tag ?? null };
    });

    expect(misura.primoTop, "niente di dipinto nella colonna della pane: la misura non regge").not.toBeNull();
    expect(
      misura.primoTop!,
      `«${misura.primoTag}» comincia a ${misura.primoTop!.toFixed(1)}, ` +
      `cioè SOTTO la barra che finisce a ${misura.barraBottom.toFixed(1)}: ` +
      `il contenuto ci si legge attraverso, sfocato.`,
    ).toBeGreaterThanOrEqual(misura.barraBottom - 1);
  });
});
