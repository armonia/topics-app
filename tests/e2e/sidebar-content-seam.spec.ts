/**
 * La giunzione fra la sidebar e il contenuto: un filo, non una sfumatura.
 *
 * Su desktop la sidebar è `fixed` SOPRA il contenuto e proiettava uno
 * `shadow-2xl` — venticinque pixel di sfumatura stesi sul contenuto. Finché le
 * due superfici avevano tinte diverse quella sfumatura si leggeva come
 * profondità. Da quando il velo della finestra è uno solo hanno lo stesso
 * pixel (misurato sulla finestra vera: sidebar #191b1e, contenuto #191b1e), e
 * l'ombra è rimasta l'unica cosa in mezzo: `#17191c` a x=211 che risale a
 * `#191b1e` solo a x=236. Tre sintomi, una causa — «non hanno bordo, c'è una
 * doppia spaziatura e i colori non sono uguali» (Attilio, 09/08).
 *
 * L'invariante: un'ombra separa due PIANI, un filo separa due ZONE dello stesso
 * piano. Con le pane flottanti la sidebar sta davvero su un piano suo e l'ombra
 * resta; senza, il confine è un pixel.
  * @covers SEAMLINE-01
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("giunzione sidebar / contenuto", () => {
  test("SEAM-1: senza pane flottanti la sidebar porta un filo, non un'ombra", async ({ page }) => {
    await goToApp(page);
    const sidebar = page.locator('[aria-label="Topics sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15000 });

    const stile = await sidebar.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        ombra: cs.boxShadow,
        bordo: cs.borderRightWidth,
        coloreBordo: cs.borderRightColor,
        flottanti: document.querySelector(".floating-splits") !== null,
      };
    });

    // Il test gira senza pane flottanti (impostazione di default): è il caso in
    // cui i due piani sono uno solo.
    expect(stile.flottanti, "questo test descrive il caso NON flottante").toBe(false);

    expect(
      stile.ombra,
      `la sidebar non deve proiettare un'ombra sul contenuto quando condividono la tinta (ombra: ${stile.ombra})`,
    ).toBe("none");
    expect(
      parseFloat(stile.bordo),
      `serve un confine netto al posto della sfumatura (bordo destro: ${stile.bordo})`,
    ).toBeGreaterThan(0);
    // E il filo deve avere un colore SUO. Il preflight di Tailwind v4 mette
    // `border: 0 solid` senza colore: una larghezza senza `border-*` esplicito
    // eredita `currentColor`, cioè il colore del TESTO — un filo quasi bianco.
    expect(
      stile.coloreBordo,
      `il filo deve portare il token del bordo, non currentColor (${stile.coloreBordo})`,
    ).not.toBe(
      await sidebar.evaluate((el) => getComputedStyle(el).color),
    );
  });
});
