import type { Page } from "@playwright/test";

/**
 * Tiene premuto DAVVERO: Playwright non ha una primitiva «touch and hold», e
 * `dispatchEvent` con oggetti letterali non basta — React legge
 * `e.touches[0].clientX`, e la lista dei tocchi vuole veri oggetti `Touch`
 * (identifier + target), altrimenti l'handler riceve `undefined` e il gesto non
 * parte mai. Quindi gli eventi si costruiscono nella pagina.
 *
 * La pausa è oltre i 500 ms di `LONG_PRESS_MS`, e il dito non si muove: sotto i
 * 10 px di slop il gesto sopravvive comunque, ma qui si prova il caso pulito.
 */
export async function longPress(page: Page, selector: string, ms = 750): Promise<void> {
  await page.locator(selector).first().evaluate((el, hold) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (type: string, touches: Touch[]) =>
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches,
        targetTouches: touches,
        changedTouches: [touch],
      }));
    fire("touchstart", [touch]);
    return new Promise<void>((resolve) => {
      setTimeout(() => { fire("touchend", []); resolve(); }, hold);
    });
  }, ms);
}
