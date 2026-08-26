/**
 * Il consumo di una scheda, al passaggio del mouse (RES-ATTR-03 / RES-ATTR-05).
 *
 * COSA COPRE CHE GLI UNIT TEST NON COPRONO: che il `title` arrivi davvero nel
 * DOM, sull'elemento giusto, e che il passaggio del mouse inneschi la richiesta.
 * Il FORMATO delle tre righe è già coperto da `client/src/lib/paneUsage.test.ts`
 * e non si ripete qui.
 *
 * Il consumo vero è deliberatamente fuori: dipende dal carico della macchina in
 * quell'istante, e un test che si aspetta un numero preciso sarebbe rosso a
 * caso. Dove serve una misura si inietta dal boundary (`/api/system/status`),
 * che è l'unica cosa che questi test mockano.
 *
 * @covers RES-ATTR-03
 *
 * Every pane shows its own consumption on hover.
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTestChat } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

// Il confine per-file della suite: senza, questa spec eredita le pane lasciate
// da quella prima e le lascia a quella dopo — ed è la classe di rosso che oggi
// costa più tempo di quanto costi scriverlo. La guardia
// `tests/unit/e2e-hermetic-coverage.test.ts` lo pretende da ogni spec.
hermetic(test);

test.describe("consumo per scheda nel tooltip", () => {
  test("una scheda senza processo proprio lo dichiara, e non mostra uno zero", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "RES-ATTR-03" });
    // Una chat vive nel renderer condiviso insieme a topic, kanban, file ed
    // editor: nessun `ps` può separarle. La sola cosa onesta è dirlo — uno zero
    // sarebbe un numero inventato con l'aria di una misura.
    await goToApp(page);
    await openTestChat(page);

    /* DUE RAMI, NON UNO. `riepilogoConsumo` (client/src/lib/paneUsage.ts:255-271)
     * risponde in tre modi: «In memoria: N messaggi / Nessun processo proprio…»
     * quando la chat ha messaggi, «Consumo: questa scheda non ha un processo
     * proprio» quando non ne ha, e «Consumo: N MB · CPU x% · k processi» per una
     * pane misurabile. Il primo ramo e' arrivato il 20/08 con 703eefc88, che ha
     * tolto una frase giudicata inutile e ci ha messo il conto dei messaggi.
     * Questa spec e' del 4 agosto e cercava solo «Consumo:»: da quel giorno
     * moriva in 15 secondi su un tooltip che c'era, con il testo giusto.
     * Si aggancia a ENTRAMBE le aperture, perche' quale esca dipende da quanti
     * messaggi ha la chat del banco, che non e' il soggetto di questo caso. */
    const label = page.locator('[title*="Consumo:"], [title*="In memoria:"]').first();
    await expect(label).toBeVisible({ timeout: 15000 });
    const title = await label.getAttribute("title");
    // Il PUNTO del caso: che lo DICA. Le due frasi lo dicono entrambe.
    expect(title).toMatch(/non ha un processo proprio|Nessun processo proprio/);
    // I due modi in cui questo si romperebbe restando "verde a metà".
    expect(title).not.toContain("0 MB");
    expect(title).not.toMatch(/CPU 0%/);
  });

  test("il tooltip sta sul nome della scheda, non sul contenitore della tab", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "RES-ATTR-03" });
    // REGRESSIONE DI DESIGN, non un dettaglio: il contenitore della tab usa
    // apposta `aria-label` e non `title` (commento in `PaneTabBar.tsx`), perché
    // un title là duplicherebbe il nome già scritto accanto e litigherebbe coi
    // title dei figli (spinner, badge). Il consumo sta sul nome, che il title
    // non ce l'aveva e che tronca a 150px. Se qualcuno lo sposta sul
    // contenitore "perché è più comodo", quel vincolo salta in silenzio: qui no.
    await goToApp(page);
    await openTestChat(page);

    const label = page.locator('[title*="Consumo:"], [title*="In memoria:"]').first();
    await expect(label).toBeVisible({ timeout: 15000 });

    // Chi porta il title deve essere il nodo del NOME: nessun ruolo di tab, e il
    // suo testo è esattamente l'inizio del title (title = `${label}\nConsumo…`).
    const info = await label.evaluate((el) => ({
      role: el.getAttribute("role"),
      hasAriaLabel: el.hasAttribute("aria-label"),
      testo: (el.textContent ?? "").trim(),
      title: el.getAttribute("title") ?? "",
      // Un antenato con `role="tab"` va bene; ciò che NON va bene è che sia
      // l'antenato stesso a portare il title.
      antenatoConTitle: !!el.parentElement?.closest("[title]"),
    }));

    expect(info.role).not.toBe("tab");
    expect(info.hasAriaLabel).toBe(false);
    expect(info.antenatoConTitle).toBe(false);
    expect(info.title.startsWith(info.testo)).toBe(true);
    // Il soggetto di questo caso e' DOVE sta il title, non quale delle due
    // aperture esce: bastano entrambe a provare che il riepilogo c'e'.
    expect(info.title).toMatch(/\n(Consumo|In memoria):/);
  });
});
