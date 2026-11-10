#!/usr/bin/env node
/**
 * scripts/ui-flow-canvas-shots.mjs - the captures of the single flow canvas,
 * for the eye of Attilio (what the bar cannot judge: whether it reads well).
 *
 * WHAT. Serves a build of `client/` (default `dist-ui`) and saves PNGs into
 * `--out <dir>`: for each of the three entrances (the editor of a flow, the
 * flow read from a card, the execution of a run) on both organizations' demos
 * and on `app.html`, light and dark, on a desktop (1440x900) and on a phone
 * (390x844, touch):
 *
 *   consorzio-editor-chiaro.png        consorzio-editor-scuro.png
 *   consorzio-card-chiaro.png          consorzio-card-scuro.png
 *   consorzio-card-dettaglio-chiaro.png  (a step's detail open in the side panel)
 *   app-esecuzione-chiaro.png          app-esecuzione-scuro.png
 *   app-esecuzione-dettaglio-chiaro.png
 *   sarim-editor-chiaro.png            sarim-card-scuro.png   ...
 *   telefono-consorzio-editor-chiaro.png  telefono-sarim-card-scuro.png  ...
 *
 * The desktop capture of an editor is scrolled to the split (the cases side by
 * side are the point); of a card or an execution, to the step on show. The
 * lane strip is scrolled to the lane the case takes (the canvas does that by
 * itself when it appears).
 *
 *   node scripts/ui-flow-canvas-shots.mjs --out <dir> [--dist dist-ui] [--only desktop|phone]
 *
 * Exit 0: every capture saved, no page error. Exit 1: a view that shows no
 * canvas, or a page error.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { devices, webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./ui-app/serve.mjs";

const SCRIPT = "ui-flow-canvas-shots";
const out = resolve(arg("out") ?? "png-reale/flusso");
const DIST = arg("dist") ?? "dist-ui";
const ONLY = arg("only");
await mkdir(out, { recursive: true });

const VIEWS = [
  { id: "consorzio-editor", entry: "consorzio", path: "/flussi/nocera-pec", mode: "edit" },
  { id: "consorzio-card", entry: "consorzio", path: "/da-fare/card/PEC-2418/flusso", mode: "read" },
  { id: "app-esecuzione", entry: "app", path: "/flussi/pec/esecuzioni/e-0412", mode: "run" },
  { id: "sarim-editor", entry: "sarim", path: "/flussi/sarim-segnalazioni", mode: "edit" },
  { id: "sarim-card", entry: "sarim", path: "/da-fare/card/SG-4124/flusso", mode: "read" },
];
const START = { app: "/panoramica", sarim: "/da-fare", consorzio: "/da-fare" };
/** The phone has the editor and the card of both demos, and the execution. */
const PHONE_VIEWS = VIEWS;
const THEMES = [["chiaro", "light"], ["scuro", "dark"]]; // allow-italian: file names of the captures (light, dark)

const servers = {};
for (const entry of ["consorzio", "sarim", "app"]) servers[entry] = await serveDist(SCRIPT, entry, DIST);
const errors = [];
const missing = [];
const saved = [];
const settle = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 30)))));

/** A page for one theme and one size: opens a view, scrolls to what matters, saves the capture. */
async function session(browser, { phone, theme }) {
  const base = phone ? { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  const context = await browser.newContext({ ...base, colorScheme: theme });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  collectErrors(page, errors);
  const dark = theme === "dark";

  const open = async (view) => {
    const { base: url } = servers[view.entry];
    if (page.url().split("?")[0] !== url) {
      await page.goto(`${url}?fresh=1&speed=0.02${dark ? "&theme=dark" : ""}#${START[view.entry]}`);
      await page.waitForFunction(() => window.__demo && document.querySelector("[data-screen]"), undefined, { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
    }
    await page.evaluate((p) => window.__demo.reset(p), view.path);
    await page.waitForFunction((p) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${p}`, view.path, { timeout: 6000 }).catch(() => {});
    if (dark) await page.evaluate(() => document.documentElement.classList.add("dark"));
    const found = await page.waitForSelector("[data-testid=flow-canvas]", { state: "visible", timeout: 8000 }).then(() => true, () => false);
    await settle(page);
    await page.waitForTimeout(450);
    return found;
  };

  /** Brings into view what the capture is about: the step on show (read, run) or the split (edit). */
  const frame = (view) => page.evaluate((mode) => {
    const target = mode === "edit" ? document.querySelector("[data-testid=flow-canvas] [data-flow-split]") : document.querySelector("[data-testid=flow-canvas] [data-flow-step-current]") ?? document.querySelector("[data-testid=flow-canvas] [data-flow-split]");
    target?.scrollIntoView({ block: mode === "edit" ? "start" : "center" });
  }, view.mode);

  const save = async (name) => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
    saved.push(name);
    console.log(`ok   ${name}`);
  };

  return { page, context, open, frame, save };
}

const browser = await webkit.launch();
try {
  for (const phone of [false, true]) {
    if (ONLY && ONLY !== (phone ? "phone" : "desktop")) continue;
    for (const [label, theme] of THEMES) {
      const s = await session(browser, { phone, theme });
      for (const view of phone ? PHONE_VIEWS : VIEWS) {
        const prefix = phone ? "telefono-" : "";
        if (!(await s.open(view))) {
          missing.push(`${prefix}${view.id}-${label}: il canvas del flusso non compare`);
          continue;
        }
        await s.frame(view);
        await s.save(`${prefix}${view.id}-${label}`);
        /* A card or a run, once in light on a desktop and once on a phone: a step's detail open in the side panel. */
        if (view.mode !== "edit" && theme === "light") {
          const pick = await s.page.evaluate(() => {
            const steps = [...document.querySelectorAll("[data-testid=flow-canvas] [data-flow-step]:not([data-flow-step-current])")];
            const column = steps.filter((st) => !st.closest("[data-flow-lanes]"));
            return (column.find((st) => st.hasAttribute("data-flow-step-done")) ?? column[0] ?? steps[0])?.getAttribute("data-flow-step") ?? null;
          });
          if (pick) {
            const card = s.page.locator(`[data-testid=flow-canvas] [data-flow-step="${pick}"] p > button[aria-pressed]`).first();
            await card.scrollIntoViewIfNeeded();
            await card.click({ position: { x: 6, y: 6 } });
            const shown = await s.page.waitForSelector(`[data-flow-step-detail="${pick}"]`, { state: "visible", timeout: 4000 }).then(() => true, () => false);
            if (shown) await s.save(`${prefix}${view.id}-dettaglio-${label}`);
            else missing.push(`${prefix}${view.id}-dettaglio-${label}: premere il passo ${pick} non apre il dettaglio`);
          }
        }
      }
      await s.context.close();
    }
  }
} finally {
  await browser.close();
  Object.values(servers).forEach((v) => v.close());
}

const unique = [...new Set(errors)];
if (unique.length) console.error(`errori della pagina:\n  ${unique.join("\n  ")}`);
if (missing.length) console.error(`catture mancanti:\n  ${missing.join("\n  ")}`);
if (unique.length || missing.length) {
  console.error(`${SCRIPT}: FAIL`);
  process.exit(1);
}
console.log(`${SCRIPT}: ok, ${saved.length} catture in ${out}`);
