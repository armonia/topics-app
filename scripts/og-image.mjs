/**
 * Render the site's Open Graph card.
 *
 *   node scripts/og-image.mjs
 *
 * The card was `icon.png` — 1024×1024, a square, declared with
 * `twitter:card=summary_large_image`, which asks for 1.91:1. Every share
 * squashed it or cropped it, and the one place a link gets a picture was
 * spending it on a logo.
 *
 * 1200×630 is the size every platform agrees on. For reference, Linear ships a
 * 272 KB JPEG, Railway a 184 KB PNG, Conductor a 28 KB WebP; PNG here because a
 * flat dark card with type compresses well and PNG is the format no scraper has
 * ever had an opinion about.
 *
 * Rendered in Chromium rather than composed in Satori: Satori cannot read WOFF2,
 * and the two faces this brand is built out of are served as WOFF2 from
 * Fontshare. A browser we already have installed reads them without being asked
 * twice. When per-article cards arrive they will need local TTFs — that is the
 * moment to revisit this, not before.
 */
import pw from '../node_modules/playwright-core/index.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(fileURLToPath(new URL('../landing/public/og.png', import.meta.url)));
const ICON = resolve(fileURLToPath(new URL('../landing/public/icon.png', import.meta.url)));

const iconData = `data:image/png;base64,${(await readFile(ICON)).toString('base64')}`;

/* The numbers are true and checkable, which is the only reason to put numbers on
   a share card at all: 2,668 commits since the repository was created on
   2026-06-01, and 141 versions in the changelog. */
const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f%5B%5D=gambarino@400&f%5B%5D=switzer@400,500,600&display=block">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/commit-mono/index.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:hsl(224 38% 4.3%);color:#e9eefc;
       font-family:Switzer,-apple-system,sans-serif;overflow:hidden;position:relative}
  /* The same dot lattice the site uses, so a shared link looks like the page it
     opens rather than like a different product. */
  .weave{position:absolute;inset:0;
    background-image:radial-gradient(hsl(220 60% 70% / .09) 1px,transparent 1px);
    background-size:26px 26px;
    -webkit-mask-image:radial-gradient(75% 70% at 30% 0,#000,transparent)}
  .wash{position:absolute;inset:-20% 30% 40% -10%;border-radius:50%;
    background:radial-gradient(circle,hsl(226 78% 44% / .30),transparent 68%);filter:blur(70px)}
  .frame{position:relative;height:100%;padding:70px 76px;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:14px}
  .brand img{width:44px;height:44px;border-radius:10px}
  .brand span{font-size:27px;font-weight:600;letter-spacing:-.015em}
  h1{margin-top:auto;font-family:Gambarino,Georgia,serif;font-weight:400;
     font-size:76px;line-height:1.0;letter-spacing:-.022em;max-width:15ch}
  h1 em{font-style:normal;background:linear-gradient(100deg,#5e9bff,#8b6cff 48%,#22d3ee);
        -webkit-background-clip:text;background-clip:text;color:transparent}
  p{margin-top:26px;font-size:27px;line-height:1.4;color:#9aa6c6;max-width:34ch}
  .foot{margin-top:auto;padding-top:34px;display:flex;gap:28px;align-items:center;
        border-top:1px solid hsl(220 22% 24%);
        font-family:"Commit Mono",monospace;font-size:19px;color:#7c89a8;
        font-variant-numeric:tabular-nums}
  .foot b{color:#e9eefc;font-weight:400}
  .dot{width:7px;height:7px;border-radius:50%;background:#34e2a0;
       box-shadow:0 0 12px #34e2a0;display:inline-block;margin-right:9px}
</style></head><body>
  <div class="weave"></div><div class="wash"></div>
  <div class="frame">
    <div class="brand"><img src="${iconData}" alt=""><span>Topics</span></div>
    <h1>Four agents.<br>One repo.<br><em>Nobody collides.</em></h1>
    <p>A desktop workspace for Claude Code, Codex, OpenCode and Gemini CLI.</p>
    <div class="foot">
      <span><span class="dot"></span>MIT &middot; macOS, Windows, Linux</span>
      <span><b>141</b> releases</span>
      <span><b>2,668</b> commits in 9 weeks</span>
    </div>
  </div>
</body></html>`;

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
await page.screenshot({ path: OUT });
await browser.close();

const { size } = await (await import('node:fs/promises')).stat(OUT);
console.log(`og.png  1200x630  ${Math.round(size / 1024)} KB`);
if (size > 400_000) {
  console.log('⚠ over 400 KB — some scrapers cap the fetch; consider JPEG');
  process.exit(1);
}
