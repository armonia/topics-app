/**
 * LE SUPERFICI, MISURATE.
 *
 * La gerarchia chrome → pagina è affermata in DUE posti — a 390px vale
 * «collassano», a 1280px vale «il chrome sta sotto» — e due affermazioni sullo
 * stesso impianto devono uscire dalla stessa aritmetica: una formula di
 * luminanza ricopiata a mano nel secondo file renderebbe i due numeri
 * incomparabili proprio nel momento in cui servono confrontabili.
 */
import type { Page } from "@playwright/test";

/** Luminanza relativa WCAG di un `rgb(...)` computato. */
export function luminance(css: string): number {
  const m = css.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) throw new Error(`colore non parsabile: ${css}`);
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Il `background-color` COMPUTATO del primo elemento che risponde al selettore. */
export async function surfaceBg(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** La colonna di navigazione: la superficie «chrome» di riferimento. */
export const SIDEBAR_SELECTOR = '[role="navigation"][aria-label="Topics sidebar"]';

/** Il piano su cui vivono le pane: la superficie «pagina» (`bg-app-bg`). */
export const PAGE_LAYER_SELECTOR = ".content-flip-layer";
