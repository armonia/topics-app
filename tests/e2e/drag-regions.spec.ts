import { expect, test } from "@playwright/test";
import { goToApp, openTestChat } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * LE ZONE DI TRASCINAMENTO DELLA FINESTRA, VERIFICATE A RUNTIME.
 *
 * Fino al 2026-07-29 la copertura la garantiva un `MutationObserver` su
 * `document.body` con `{childList, subtree: true}`: qualunque nodo comparisse,
 * l'observer ripassava e specchiava `.app-drag-region` / `.app-no-drag`
 * sull'attributo `data-tauri-drag-region`. Funzionava, e costava: xterm
 * sostituisce i figli di ogni riga a ogni refresh, quindi con sedici PTY erano
 * migliaia di record al secondo — allocati e accodati PRIMA che il debounce a
 * valle potesse dire "non era niente".
 *
 * Adesso l'attributo lo mette il render (`lib/shell/dragRegion.ts`). Il rischio
 * si sposta: non più il costo, ma la DIMENTICANZA — un `.app-no-drag` nuovo
 * senza il suo `{...NO_DRAG_REGION}` diventa una zona che trascina la finestra
 * quando dovrebbe cliccare, e nessun typecheck se ne accorge.
 *
 * Questo test fa una volta sola, a schermo montato, esattamente il lavoro che
 * l'observer faceva per sempre: cerca l'elemento con la classe e senza
 * l'attributo. La stessa query, `:not([data-tauri-drag-region])`, che
 * `wireTauriDragRegions` usava come guardia di idempotenza.
 *
 * Perché a runtime e non un grep sul sorgente: la classe può arrivare da una
 * prop, da un template, da una condizione. Il DOM è l'unico posto dove la
 * domanda "questo elemento ha la classe?" ha una risposta certa.
 */

/** L'attributo è inerte fuori da Tauri, quindi il test vale anche in Chromium:
 *  quello che verifica è la COPERTURA del markup, non l'effetto sulla finestra. */
const UNCOVERED =
  ".app-drag-region:not([data-tauri-drag-region]), .app-no-drag:not([data-tauri-drag-region])";

async function uncovered(page: import("@playwright/test").Page) {
  return page.evaluate((sel: string) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className.toString().slice(0, 120),
      testid: el.getAttribute("data-testid"),
    }));
  }, UNCOVERED);
}

test.describe("Zone di trascinamento della finestra", () => {
  test("DRAG-01: nessuna chrome della shell resta senza il suo attributo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-08" });
    await goToApp(page);
    // L'intestazione dell'app, la barra degli Spazi e la sidebar sono montate.
    await expect(page.locator(".app-drag-region").first()).toBeAttached({ timeout: 15000 });
    expect(await uncovered(page)).toEqual([]);
  });

  test("DRAG-02: nemmeno la chrome che compare dopo, con una chat aperta", async ({ page }) => {
    // È il caso per cui l'observer esisteva: tab bar e header di pane nascono
    // molto dopo il boot. Se la copertura dipendesse ancora da lui, toglierlo si
    // vedrebbe qui e non nel test precedente.
    await goToApp(page);
    await openTestChat(page);
    await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeAttached({
      timeout: 15000,
    });
    expect(await uncovered(page)).toEqual([]);
  });

  test("DRAG-03: le tab non trascinano la finestra", async ({ page }) => {
    // La rinuncia esplicita, che è la metà del contratto che si rompe in modo
    // fastidioso: una tab dentro un antenato `deep` senza il suo `false` non si
    // può riordinare col drag, perché il mousedown muove la finestra.
    await goToApp(page);
    await openTestChat(page);
    const tab = page.locator('[data-testid^="pane-tab-"]').first();
    await tab.waitFor({ state: "visible", timeout: 15000 });
    await expect(tab).toHaveAttribute("data-tauri-drag-region", "false");
  });
});
