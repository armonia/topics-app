// Bar for the server's headless Chromium (the one that answers when no window
// shows the pane). Same three checks as pane-bar.sh, same criteria:
//   1. console.hetzner.com -> accounts.hetzner.com/login in under 60 s
//   2. bot.sannysoft.com: failed rows (measurement)
//   3. a Cloudflare challenge page (measurement)
//
// usage: bun scripts/anti-bot/chromium-bar.ts [--prima] [--solo-misure]
//   --prima  the same browser WITHOUT the switch and the reduced UA: reproduces the defect
// Exit 0 if Hetzner passes, 1 if not.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { HEADLESS_AUTOMATION_ARGS, reducedChromeUserAgent } from "../../server/lib/headless-chromium-stealth";

const prima = process.argv.includes("--prima");
const soloMisure = process.argv.includes("--solo-misure");
// Same choice as the server: CHROMIUM_PATH, then Playwright's own; when that is
// missing (package version differs from the cache) the latest installed chromium-*.
function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort() : [];
  for (const d of dirs.reverse()) {
    const p = join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(p)) return p;
  }
  return bundled;
}
const executablePath = findChromium();
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: prima ? [] : [...HEADLESS_AUTOMATION_ARGS],
});
const ua = prima ? undefined : reducedChromeUserAgent(browser.version());
console.log(`modo: ${prima ? "PRIMA (senza correzione)" : "DOPO (switch + UA ridotto)"}  chromium ${browser.version()}`);

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(ua ? { userAgent: ua } : {}) });
  return { ctx, page: await ctx.newPage() };
}

let fail = false;
if (!soloMisure) {
  const { ctx, page } = await fresh();
  const t0 = Date.now();
  await page.goto("https://console.hetzner.com/projects", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  let ok = false;
  while (Date.now() - t0 < 60_000) {
    const u = page.url();
    if (u.startsWith("https://accounts.hetzner.com/login")) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(ok ? `hetzner: PASSA in ${secs}s (login raggiunto)` : `hetzner: NON PASSA dopo ${secs}s, fermo su ${page.url()}`);
  fail = !ok;
  await ctx.close();
}

{
  const { ctx, page } = await fresh();
  await page.goto("https://bot.sannysoft.com", { waitUntil: "load", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(5_000);
  const r = await page.evaluate(() => ({
    failed: [...document.querySelectorAll("td.failed")].map((td) => ((td.previousElementSibling as HTMLElement) || (td as HTMLElement)).innerText.trim()),
    passed: document.querySelectorAll("td.passed").length,
  })).catch((e) => ({ error: String(e) }));
  console.log("sannysoft:", JSON.stringify(r));
  await ctx.close();
}

{
  const { ctx, page } = await fresh();
  await page.goto("https://www.scrapingcourse.com/cloudflare-challenge", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(20_000);
  // Passing the challenge reloads the page: a read in the middle fails, so retry.
  let text = "";
  for (let i = 0; i < 4 && !text; i++) {
    text = await page.evaluate(() => document.title + " | " + document.body.innerText.slice(0, 120).replace(/\n/g, " ")).catch(() => "");
    if (!text) await page.waitForTimeout(3_000);
  }
  console.log(/bypassed/i.test(text) ? `cloudflare: SFIDA PASSATA  ${text}` : `cloudflare: sfida NON passata  ${text}`);
  await ctx.close();
}

await browser.close();
if (!soloMisure) console.log(fail ? "BARRA: ROSSA" : "BARRA: VERDE");
process.exit(fail ? 1 : 0);
