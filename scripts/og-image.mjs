/**
 * Render the site's Open Graph card.
 *
 *   bun run og
 *
 * The card was `icon.png` — 1024×1024, a square, declared with
 * `twitter:card=summary_large_image`, which asks for 1.91:1. Every share
 * squashed it or cropped it, and the one place a link gets a picture was
 * spending it on a logo.
 *
 * 1200×630 is the size every platform agrees on. For reference, Linear ships a
 * 272 KB JPEG, Railway a 184 KB PNG, Conductor a 28 KB WebP; PNG here because
 * type on a flat field compresses well and PNG is the format no scraper has
 * ever had an opinion about.
 *
 * It carries the site's own ramp: a cool near-white ground at hue 265 and the
 * product screenshot as the dark end of that same ramp, three degrees of hue
 * away. A card that opens onto a page it does not resemble is a small broken
 * promise, so the card makes the page's argument rather than a second one.
 *
 * Rendered in Chromium rather than composed in Satori: Satori cannot read
 * WOFF2, and the faces this brand is built from are served as WOFF2 by
 * Fontshare. A browser we already have installed reads them without being
 * asked twice.
 *
 * Numbers come from `landing/src/lib/repo-stats.ts`, the same module the home
 * page reads — which is why this runs under bun rather than node. They were
 * typed in by hand before and both were wrong: "141 releases" was the changelog
 * version count, and "2,668 commits in 9 weeks" measured from the day the
 * GitHub repo was created rather than from the first commit, which is four
 * months earlier. A number on a share card is worth having only if it is right.
 */
import pw from '../node_modules/playwright-core/index.js';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoStats } from '../landing/src/lib/repo-stats.ts';

const OUT = resolve(fileURLToPath(new URL('../landing/public/og.png', import.meta.url)));
const ICON = resolve(fileURLToPath(new URL('../landing/public/icon.png', import.meta.url)));
const SHOT = resolve(fileURLToPath(new URL('../landing/public/img/organize.webp', import.meta.url)));

const iconData = `data:image/png;base64,${(await readFile(ICON)).toString('base64')}`;
const shotData = `data:image/webp;base64,${(await readFile(SHOT)).toString('base64')}`;

const stats = repoStats();
// `commits` is null on a checkout without usable history, and `releases` no
// longer exists at all: no file in the tree carries a truthful published-release
// count, so the field was removed rather than left to drift. The card drops the
// line it cannot fill instead of printing `undefined` into an image nobody
// re-reads before it is scraped.
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-GB') : null);
const commits = fmt(stats.commits);

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f%5B%5D=gambarino@400&f%5B%5D=switzer@400,500,600&display=block">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/commit-mono/index.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#f9fafc;color:#13161d;
       font-family:Switzer,-apple-system,sans-serif;overflow:hidden;position:relative}
  .frame{position:relative;height:100%;padding:64px 0 64px 70px;display:flex;flex-direction:column;
         width:660px}
  .brand{display:flex;align-items:center;gap:13px}
  .brand img{width:40px;height:40px;border-radius:9px}
  .brand span{font-size:25px;font-weight:600;letter-spacing:-.015em}
  h1{margin-top:auto;font-family:Gambarino,Georgia,serif;font-weight:400;
     font-size:70px;line-height:.99;letter-spacing:-.022em}
  h1 em{font-style:normal;color:#016770}
  p{margin-top:24px;font-size:24px;line-height:1.4;color:#51555e;max-width:31ch}
  .foot{margin-top:auto;padding-top:28px;display:flex;gap:26px;align-items:center;
        border-top:1px solid #e1e3e7;
        font-family:"Commit Mono",monospace;font-size:17px;color:#656971;
        font-variant-numeric:tabular-nums}
  .foot b{color:#13161d;font-weight:400}
  .dot{width:7px;height:7px;border-radius:50%;background:#1f6f38;display:inline-block;margin-right:9px}
  /* The one dark object, bled off the right edge and tilted just enough to read
     as an object on a sheet rather than as a second panel. */
  .slab{position:absolute;right:-190px;top:64px;width:660px;height:502px;
        border-radius:8px;overflow:hidden;background:#07090f;
        transform:rotate(-3.5deg);
        box-shadow:inset 0 1px 0 0 rgba(255,255,255,.06),0 2px 6px -2px rgba(15,19,29,.07),
                   0 14px 34px -14px rgba(15,19,29,.10),0 44px 90px -32px rgba(15,19,29,.16)}
  .slab img{width:100%;height:100%;object-fit:cover;object-position:left top}
</style></head><body>
  <div class="slab"><img src="${shotData}" alt=""></div>
  <div class="frame">
    <div class="brand"><img src="${iconData}" alt=""><span>Topics</span></div>
    <h1>Four agents.<br>One repo.<br><em>Nobody collides.</em></h1>
    <p>A desktop workspace for Claude Code, Codex, OpenCode and Gemini CLI.</p>
    <div class="foot">
      <span><span class="dot"></span>MIT &middot; macOS, Windows, Linux</span>
      ${commits ? `<span><b>${commits}</b> commits</span>` : ''}
      <span>v${stats.version}</span>
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

const { size } = await stat(OUT);
console.log(`og.png  1200x630  ${Math.round(size / 1024)} KB  ·  v${stats.version}${commits ? `, ${commits} commits` : ' (no git history here: the commit line is omitted)'}`);
if (size > 400_000) {
  console.log('⚠ over 400 KB — some scrapers cap the fetch; consider JPEG');
  process.exit(1);
}
