#!/usr/bin/env node
/**
 * scripts/ui-gallery-shots.mjs - photograph the screens of the UI gallery.
 *
 * Serves `client/dist-ui/` (run `bun run build:ui` first) on a loopback port,
 * opens `ui.html#<id>` in headless WebKit at 1440x900 and deviceScaleFactor 2,
 * and saves `<out>/<id>.png`. Exits 1 if a screen logs an error, throws, fails
 * a request, or never mounts: a picture of a broken screen is not a picture.
 *
 *   node scripts/ui-gallery-shots.mjs --out <dir> [--ids w01,n12] [--theme dark]
 *
 * One browser for the whole run, closed at the end: the Mac this runs on is
 * often short of memory.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "client/dist-ui");
const FIRST_ROUND = ["shell", "w01", "n12", "v02", "x06", "x01", "x03", "n18", "a02"];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = resolve(arg("out", join(DIST, "shots")));
const ids = arg("ids", FIRST_ROUND.join(",")).split(",").filter(Boolean);
const theme = arg("theme", "light");

if (!existsSync(join(DIST, "ui.html"))) {
  console.error("ui-gallery-shots: client/dist-ui/ui.html is missing, run `bun run build:ui` first.");
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const path = join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(DIST)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/ui.html${theme === "dark" ? "?theme=dark" : ""}`;

await mkdir(out, { recursive: true });
const browser = await webkit.launch();
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme === "dark" ? "dark" : "light" });
  for (const id of ids) {
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()}`));
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
    await page.goto(`${base}#${id}`);
    const mounted = await page.waitForSelector(`[data-screen="${id}"]`, { timeout: 15000 }).then(() => true, () => false);
    if (!mounted) errors.push("the screen never mounted");
    await page.evaluate(() => document.fonts.ready);
    const file = join(out, `${id}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    await page.close();
    if (errors.length) failures.push(`${id}: ${errors.join(" | ")}`);
    console.log(`${errors.length ? "FAIL" : "ok  "} ${id} -> ${file}`);
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`ui-gallery-shots: ${failures.length} screen(s) with errors\n` + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log(`ui-gallery-shots: ${ids.length} screen(s), zero console errors (${theme})`);
