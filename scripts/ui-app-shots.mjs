#!/usr/bin/env node
/**
 * scripts/ui-app-shots.mjs - one capture of every screen of the organizations
 * preview, as the app draws it, for the board of the mockups.
 *
 * WHY. The board (`~/Projects/topics-app-mockup-flussi/board.html`) showed the
 * mockups; Attilio judges the real app by putting it next to them. Each
 * capture is the first sample address of the place that draws that mockup id,
 * from a fresh state, so the board shows what a person sees on first opening.
 *
 * WHAT. Serves `client/dist-ui/` (run `bun run build:ui` first), opens every
 * place in headless WebKit at 1440x900 (device scale 2), saves `<id>.png`,
 * a 480px JPEG thumbnail in `thumbs/<id>.jpg`, and `map.json` with the address
 * and title of each id, which the board uses for its «Apri nell'app» link.
 * The icon legend (z01) lives in the gallery (`ui.html#z01`), not in the app.
 *
 *   node scripts/ui-app-shots.mjs --out <dir> [--theme dark] [--entry sarim|consorzio]
 *
 * `--entry sarim` captures the SARIM edition (`sarim.html`), `--entry consorzio` the Consorzio one (`consorzio.html`): every place, and
 * three phones (Oggi, the kanban of «Da fare», a compare of contract versions); (allow-italian: quotes the Italian interface)
 * the icon legend belongs to the gallery of app.html and is left out.
 *
 * Exit 1 on a page error or a place that lands on the wrong screen.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./ui-app/serve.mjs";

const out = resolve(arg("out") ?? "png-reale/app");
const theme = arg("theme") ?? "light";
const entry = arg("entry") ?? "app";
await mkdir(join(out, "thumbs"), { recursive: true });

const { base, close } = await serveDist("ui-app-shots", entry);
const browser = await webkit.launch();
const errors = [];
const wrong = [];
/* The 480px thumbnails come from macOS `sips`; elsewhere (the PC) they are skipped and made later on the Mac. */
const thumb = (file, id) => {
  if (process.platform !== "darwin") return;
  execFileSync("sips", ["-Z", "480", "-s", "format", "jpeg", "-s", "formatOptions", "70", file, "--out", join(out, "thumbs", `${id}.jpg`)], { stdio: "ignore" });
};
const map = {};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme === "dark" ? "dark" : "light" });
  const page = await context.newPage();
  collectErrors(page, errors);
  await page.goto(`${base}?fresh=1&speed=0.02${theme === "dark" ? "&theme=dark" : ""}#/${entry !== "app" ? "oggi" : "panoramica"}`);
  await page.waitForFunction(() => window.__demo);
  await page.evaluate(() => document.fonts.ready);
  const places = await page.evaluate(() => window.__demo.places());
  const seen = new Set();
  for (const place of places) {
    if (seen.has(place.id) || ["search", "new-tab"].includes(place.id)) continue;
    seen.add(place.id);
    const sample = place.samples[0];
    await page.evaluate((p) => window.__demo.reset(p), sample);
    await page.waitForFunction((p) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${p}`, sample, { timeout: 5000 }).catch(() => {});
    if (theme === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(450);
    const landed = await page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen"));
    if (landed !== place.id) wrong.push(`${place.id} at ${sample} drew ${landed}`);
    const file = join(out, `${place.id}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    thumb(file, place.id);
    map[place.id] = { path: sample, title: place.title };
    console.log(`${landed === place.id ? "ok  " : "FAIL"} ${place.id.padEnd(8)} ${sample}`);
  }
  /* The legend of the icon system is a page of the gallery. */
  if (entry === "app") {
    const legend = await context.newPage();
    collectErrors(legend, errors);
    await legend.goto(`${base.replace("app.html", "ui.html")}${theme === "dark" ? "?theme=dark" : ""}#z01`);
    await legend.waitForTimeout(600);
    await legend.screenshot({ path: join(out, "z01.png") });
    thumb(join(out, "z01.png"), "z01");
    map.z01 = { path: null, gallery: "ui.html#z01", title: "Sistema di icone" };
  }
  /* m01 is not a place but the layout under 768px: three phones side by side,
     each a real app at 390x844 (the same address on a phone draws this). */
  const phones = entry === "sarim"
    ? [["/da-fare", "Da fare"], ["/da-fare/kanban", "Kanban"], ["/conoscenza/contratti/c-castellabate/confronto/2/3", "Confronto versioni"]] // allow-italian: captions of the capture sheet
    : entry === "consorzio"
    ? [["/da-fare", "Da fare"], ["/da-fare/kanban", "Kanban"], ["/conoscenza/contratti/ct-ingegneria-lotto1/confronto/1/2", "Confronto versioni"]] // allow-italian: captions of the capture sheet
    : [["/oggi", "Oggi"], ["/da-fare/2418", "Da confermare"], ["/pratiche/2418", "La pratica"]];
  const sheet = await context.newPage();
  collectErrors(sheet, errors);
  const frame = (p) => `${base}?fresh=1&speed=0.02${theme === "dark" ? "&theme=dark" : ""}#${p}`;
  await sheet.setContent(`<body style="margin:0;height:900px;display:flex;justify-content:center;align-items:center;gap:48px;background:${theme === "dark" ? "#18181b" : "#e9e9ec"};font:500 13px -apple-system,system-ui">${phones.map(([p, label]) => `<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:6px"><iframe src="${frame(p)}" style="width:390px;height:812px;border:0;border-radius:28px;box-shadow:0 8px 40px rgba(0,0,0,.18);background:#fff"></iframe><figcaption style="color:#777">${label}</figcaption></figure>`).join("")}</body>`);
  await sheet.waitForTimeout(1500);
  await sheet.screenshot({ path: join(out, "m01.png") });
  thumb(join(out, "m01.png"), "m01");
  map.m01 = { path: "/da-fare", title: "Telefono", phone: true };
  await writeFile(join(out, "map.json"), `${JSON.stringify(map, null, 1)}\n`);
  await context.close();
} finally {
  await browser.close();
  close();
}
if (errors.length) console.error(`errori della pagina:\n  ${[...new Set(errors)].join("\n  ")}`);
if (wrong.length) console.error(`schermate sbagliate:\n  ${wrong.join("\n  ")}`);
if (errors.length || wrong.length) process.exit(1);
console.log(`ui-app-shots: ok, ${Object.keys(map).length} schermate in ${out}`);
