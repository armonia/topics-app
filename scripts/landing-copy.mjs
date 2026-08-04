/**
 * Copy gate for the landing site. Runs against the BUILT pages.
 *
 *   cd landing && bun run build && cd .. && bun run check:copy
 *
 * It reads the RENDERED text, not the sources, which is the only way to catch
 * the interesting failures. Two of them were live on this site:
 *
 *   · 109 curly quotes on the pages and zero in any source file. SmartyPants is
 *     on by default in Astro's markdown processor and was rewriting every
 *     straight quote at build time. Curly quotes are a listed tell of
 *     machine-written prose, so the build was manufacturing a signal the author
 *     never wrote, on a site whose credibility rests on a person having written
 *     it. Source-only linting cannot see that.
 *   · 299 of the 408 em dashes came from release notes generated out of commit
 *     subjects. Nobody wrote them as prose and nobody would have found them by
 *     reading the content directory.
 *
 * The patterns are from Wikipedia's "Signs of AI writing", maintained by
 * WikiProject AI Cleanup. The point is not that any one of them is forbidden:
 * it is that a DENSITY of them is what a reader recognises, and the survey this
 * site was planned against measures that a reader who suspects machine prose
 * abandons the page 78% of the time and avoids the source afterwards 71% of the
 * time. So the thresholds are density-based, and zero is only required where
 * zero is achievable without hurting the writing.
 */
import pw from '../node_modules/playwright-core/index.js';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../landing/dist', import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain',
                '.webp': 'image/webp', '.svg': 'image/svg+xml', '.xml': 'application/xml' };

/**
 * `max` is per 1000 words unless `total` is set, in which case it is absolute.
 * A `note` records an allowance we looked at and decided to keep, so nobody has
 * to re-derive it: both of the current ones are regex false positives rather
 * than writing anyone should fix.
 *
 * A pattern that fires on a legitimate technical term is the pattern's bug, not
 * the prose's. `vibrant` is the promotional adjective; `vibrancy` is the macOS
 * NSVisualEffectView effect and appears twenty times in release notes, used
 * correctly. Narrowing the regex was the fix. Widening the allowance would have
 * hidden the next real hit behind it.
 */
const PATTERNS = [
  { name: 'em dash', re: /—/g, total: 0 },
  { name: 'curly quote', re: /[‘’“”]/g, total: 0 },
  { name: 'AI vocabulary', total: 0,
    re: /\b(delve|crucial|pivotal|showcase|tapestry|testament|underscore[sd]?|vibrant|intricate|realm|leverage|robust|seamless|holistic|foster(s|ing)?|garner|myriad|plethora|nuanced|paradigm|synerg\w+|elevate|unlock|empower|streamline|cutting-edge|game-chang\w+|revolutioniz\w+)\b/gi,
    note: 'the pattern says `vibrant`, not `vibrancy`: the second is the macOS NSVisualEffectView API and appears 20 times in release notes, used correctly' },
  { name: 'negative parallelism', re: /\bnot (just|merely|only)\b[^.!?]{0,70}\b(but|it'?s|its)\b/gi, total: 1,
    note: 'one false positive: the regex spans two adjacent changelog entries' },
  { name: 'signposting', re: /\b(let'?s (dive|explore|break|take a look)|here'?s what you need|without further ado|in this (article|post|section) (we|you)|we'?ll (explore|dive|cover))\b/gi, total: 0 },
  { name: 'hedge filler', re: /\b(it is important to note|it should be noted|it'?s worth noting|needless to say|at the end of the day)\b/gi, total: 1,
    note: 'one false positive: a daily digest that literally arrives at the end of the day' },
  { name: 'authority trope', re: /\b(the real question is|at its core|what really matters|fundamentally,|the deeper issue|the heart of the matter|in reality,)\b/gi, total: 0 },
  { name: '-ing puffery', re: /\b(highlighting|underscoring|emphasizing|showcasing|exemplifying|symbolizing|epitomizing) (the|its|a|how)\b/gi, total: 0 },
  { name: 'significance puffery', re: /\b(stands as|serves as|is a testament|plays a (vital|crucial|key|pivotal) role|marks a (shift|turning point)|evolving landscape|indelible mark|deeply rooted)\b/gi, total: 0 },
  { name: 'promotional adjectives', re: /\b(boasts a|nestled|in the heart of|breathtaking|must-visit|stunning|renowned|groundbreaking)\b/gi, total: 0 },
  { name: 'weasel attribution', re: /\b(industry reports|observers have|experts (argue|believe|say)|some critics argue|studies (show|suggest) that)\b/gi, total: 0 },
  { name: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, total: 0 },
  { name: 'sycophancy', re: /\b(great question|you'?re absolutely right|excellent point|i hope this helps)\b/gi, total: 0 },
];

const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const pages = [];
for await (const f of walk(ROOT)) {
  if (f.endsWith('.html') && !f.includes('/app/')) pages.push('/' + relative(ROOT, f).replace(/index\.html$/, ''));
}

const browser = await pw.chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

let words = 0;
const hits = new Map();   // pattern name -> [{path, sample}]
for (const p of pages) {
  await page.goto(base + p, { waitUntil: 'domcontentloaded' });
  // Prose only: code, SVG, timestamps and the chart data tables are not writing.
  //
  // The title and the meta description are IN, even though they are not on the
  // page. They are the copy a reader meets first, in a search result and on a
  // shared card, and leaving them out of the gate is how the one sentence with
  // the widest reach ends up being the only one nobody proofread.
  const text = await page.evaluate(() => {
    const el = document.querySelector('main') || document.body;
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,svg,pre,code,time,.viz__data,[aria-hidden="true"]').forEach((n) => n.remove());
    const meta = [
      document.title,
      document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '',
      document.querySelector('meta[property="og:image:alt"]')?.getAttribute('content') ?? '',
    ].join(' ');
    return (meta + ' ' + c.innerText).replace(/\s+/g, ' ').trim();
  });
  words += text.split(/\s+/).filter(Boolean).length;
  for (const pat of PATTERNS) {
    for (const m of text.match(pat.re) || []) {
      if (!hits.has(pat.name)) hits.set(pat.name, []);
      hits.get(pat.name).push({ path: p, sample: m });
    }
  }
}
await browser.close();
srv.close();

console.log(`${pages.length} pages · ${words.toLocaleString('en-GB')} words of rendered prose\n`);
let failed = 0;
for (const pat of PATTERNS) {
  const found = hits.get(pat.name) ?? [];
  const n = found.length;
  const limit = pat.total ?? Math.round((pat.max * words) / 1000);
  const ok = n <= limit;
  if (!ok) failed++;
  const rate = n ? `  (${((n * 1000) / words).toFixed(2)}/1000)` : '';
  console.log(`  ${ok ? '·' : '✗'} ${pat.name.padEnd(24)} ${String(n).padStart(4)} / ${limit}${rate}`);
  if (!ok) {
    const byPage = [...new Set(found.map((f) => f.path))].slice(0, 6);
    for (const p of byPage) {
      const s = found.filter((f) => f.path === p).slice(0, 3).map((f) => `"${f.sample}"`).join(', ');
      console.log(`        ${p}  ${s}`);
    }
  } else if (pat.note && n) {
    console.log(`        kept: ${pat.note}`);
  }
}

console.log(failed ? `\n✗ ${failed} pattern(s) over budget` : '\n✓ copy gate green');
process.exit(failed ? 1 : 0);
