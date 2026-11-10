/**
 * scripts/ui-app/phone-runner.mjs - the engine of the phone walks
 * (`ui-app-phone.mjs` for app.html, `ui-orbit-phone.mjs` for orbit.html):
 * opens the built preview in headless WebKit as an iPhone-sized touch screen
 * (390x844) and, on every step, checks that the right place is drawn
 * (`data-screen`), that the page does not scroll sideways (document width <=
 * viewport), that no scroller scrolls sideways unless it is a strip made for it
 * (`overflow-x-auto`), and that no element pokes out of the screen unless it
 * sits in such a strip.
 *
 * A step: an address (`go`) or a press (`press`, a function returning a
 * locator), then the place expected (`screen`) or an overlay that must open
 * (`overlay`, closed again with Escape), and an optional `check(page)`
 * returning an error line or null. `--shots <dir>` saves one capture per step.
 * Exits 1 on the first wrong step or on any page error.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { webkit, devices } from "playwright";
import { arg, collectErrors, serveDist } from "./serve.mjs";

const shots = arg("shots") ? resolve(arg("shots")) : undefined;

export async function runPhone({ script, entry = "app", start, steps: given, done }) {
  /* `steps` may be a function of the page, for an entry whose addresses are read from the page itself. */
  let steps = Array.isArray(given) ? given : [];
  if (shots) await mkdir(shots, { recursive: true });
  const { base, close } = await serveDist(script, entry);
  const browser = await webkit.launch();
  const errors = [];
  let failure = null;
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    collectErrors(page, errors);
    await page.goto(`${base}?fresh=1&speed=0.05#${start}`);
    await page.waitForFunction(() => window.__demo);
    if (typeof given === "function") steps = await given(page);

    /** Sideways overflow: the page itself, or an element past the right edge outside a horizontal scroller. */
    const overflow = () => page.evaluate(() => {
      const vw = window.innerWidth;
      const doc = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      if (doc > vw + 1) return `la pagina è larga ${doc}px su ${vw}px`;
      /* A vertical scroller turns overflow-x into auto by itself (CSS), so content
         too wide for it scrolls sideways too. Only a strip that asks for it
         (overflow-x-auto, overflow-auto: tabs, wide tables) may do that. */
      for (const el of document.querySelectorAll("[data-screen], [data-screen] *")) {
        if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth === 0) continue;
        if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX)) continue;
        if (/(^|\s)overflow-(x-)?(auto|scroll)(\s|$)/.test(String(el.className))) continue;
        return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""} scorre di lato di ${el.scrollWidth - el.clientWidth}px`;
      }
      for (const el of document.querySelectorAll("[data-screen] *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1) continue;
        let p = el.parentElement;
        let scrolled = false;
        while (p) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) { scrolled = true; break; }
          p = p.parentElement;
        }
        if (!scrolled) return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""} esce di ${Math.round(r.right - vw)}px`;
      }
      return null;
    });

    for (const [i, step] of steps.entries()) {
      if (step.go) {
        await page.evaluate((p) => { location.hash = p; }, step.go);
      } else {
        const target = step.press(page);
        const found = await target.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
        if (!found) { failure = `passo ${i + 1} (${step.what}): niente da premere`; break; }
        await target.tap();
      }
      await page.waitForTimeout(250);
      if (step.screen) {
        const ok = await page.waitForSelector(`[data-screen="${step.screen}"]`, { timeout: 5000 }).then(() => true, () => false);
        if (!ok) {
          const on = await page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen"));
          failure = `passo ${i + 1} (${step.what}): atteso ${step.screen}, c'è ${on ?? "niente"}`;
          break;
        }
      }
      if (step.overlay) {
        const ok = await page.waitForSelector(step.overlay, { timeout: 3000 }).then(() => true, () => false);
        if (!ok) { failure = `passo ${i + 1} (${step.what}): non si apre`; break; }
      }
      let wide = await overflow();
      if (!wide && step.check) wide = await step.check(page);
      console.log(`${wide ? "FAIL" : "ok  "} ${String(i + 1).padStart(2)} ${step.what}${wide ? ` -> ${wide}` : ""}`);
      if (shots) await page.screenshot({ path: join(shots, `telefono-${String(i + 1).padStart(2, "0")}.png`) });
      if (wide) { failure = `passo ${i + 1} (${step.what}): ${wide}`; break; }
      if (step.overlay) await page.keyboard.press("Escape");
    }
    await context.close();
  } finally {
    await browser.close();
    close();
  }

  if (errors.length) console.error(`errori della pagina:\n  ${[...new Set(errors)].join("\n  ")}`);
  if (failure || errors.length) {
    console.error(`${script}: FAIL${failure ? `, ${failure}` : ""}`);
    process.exit(1);
  }
  console.log(done(steps.length));
}
