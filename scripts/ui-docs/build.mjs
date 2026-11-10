#!/usr/bin/env node
/**
 * Builds the originals of the example cases of the organizations preview.
 *
 * WHY. A case in the preview shows its originals next to what the AI read in
 * them, and a value is only believable if the words it quotes are really on the
 * page. So every document is a real file (a PDF and one JPEG per page under
 * `client/public-ui/docs/<case>/`), and the text a seed carries for a page is
 * the text that page prints, checked here, not retyped by hand.
 *
 * HOW. `templates/<case>/<doc>.html` holds the pages of one document, each a
 * `<section class="page">`, styled by `templates/base.css`; `<!--@include x arg-->`
 * pastes `templates/_partials/x.html` with `{{arg}}` replaced (letterhead,
 * example note with its page number). A page size
 * other than A4 is declared with `<meta name="page-size" content="210mm 380mm">`.
 * One headless Chromium renders every template, writes `<doc>.pdf` and
 * `<doc>-<n>.jpg` (1240 px wide), reads back the visible text of each page and
 * compares it, whitespace collapsed, with the seeds in
 * `client/src/ui/fixtures/org/cases/` (loaded through `bun`, which runs the
 * TypeScript as is). It also checks that every field quote is on its page, that
 * paths and page counts agree, that no page overflows (clipped text would be in
 * the text but not on the image), and that the folder stays under 8 MB.
 *
 *   taskpolicy -b node scripts/ui-docs/build.mjs                 build and check
 *   taskpolicy -b node scripts/ui-docs/build.mjs --write-text    also rewrite doc-text.ts
 *   taskpolicy -b node scripts/ui-docs/build.mjs --only 2418     one case
 *
 * Exit 0 when everything agrees, 1 on any mismatch, 2 when it cannot run.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const TEMPLATES = join(HERE, 'templates');
const PARTIALS = join(TEMPLATES, '_partials');
const OUT = join(ROOT, 'client/public-ui/docs');
const CASES_DIR = join(ROOT, 'client/src/ui/fixtures/org/cases');
const DOC_TEXT_FILE = join(CASES_DIR, 'doc-text.ts');

const IMAGE_WIDTH = 1240;
const JPEG_QUALITY = 78;
const MAX_BYTES = 8 * 1024 * 1024;
/** 210 mm in CSS pixels: every page is A4 wide, so one scale fits all. */
const PAGE_WIDTH_PX = (210 / 25.4) * 96;
const LONG_DASH = String.fromCharCode(0x2014);
const MARKER = '// allow-italian: fixture data, shown as written';

const args = process.argv.slice(2);
const writeText = args.includes('--write-text');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;

const errors = [];
const fail = (msg) => errors.push(msg);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Every template, as `{ caseId, docId, file }`. */
function listTemplates() {
  const out = [];
  for (const caseId of readdirSync(TEMPLATES).sort()) {
    const dir = join(TEMPLATES, caseId);
    if (caseId.startsWith('_') || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.html')) out.push({ caseId, docId: f.slice(0, -5), file: join(dir, f) });
    }
  }
  return out;
}

/** The template with its partials pasted, inside a page that carries base.css. */
function compose(file) {
  let body = readFileSync(file, 'utf8');
  for (let i = 0; i < 3; i++) {
    body = body.replace(/<!--@include ([\w-]+)(?: ([^>]*?))?-->/g, (_, name, arg = '') => {
      const p = join(PARTIALS, `${name}.html`);
      if (!existsSync(p)) {
        fail(`${file}: unknown partial ${name}`);
        return '';
      }
      return readFileSync(p, 'utf8').replaceAll('{{arg}}', arg.trim());
    });
  }
  if (body.includes(LONG_DASH)) fail(`${file}: contains a long dash`);
  const size = body.match(/<meta name="page-size" content="([^"]+)">/)?.[1] ?? '210mm 297mm';
  const height = size.split(/\s+/)[1];
  const css = readFileSync(join(TEMPLATES, 'base.css'), 'utf8');
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${css}
@page { size: ${size}; margin: 0; }
:root { --page-h: ${height}; }</style></head><body>${body}</body></html>`;
  return { html, size, height };
}

/** Cases and the generated text, as the seeds export them, through bun. */
function loadSeeds() {
  const script = `
    const { CASES } = await import(${JSON.stringify(join(CASES_DIR, 'index.ts'))});
    const { DOC_TEXT } = await import(${JSON.stringify(DOC_TEXT_FILE)});
    process.stdout.write(JSON.stringify({ CASES, DOC_TEXT }));
  `;
  const r = spawnSync('bun', ['-e', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`cannot load the seeds through bun:\n${r.stderr}`);
    process.exit(2);
  }
  return JSON.parse(r.stdout);
}

function writeDocText(texts) {
  const keys = Object.keys(texts).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const lines = [
    '/**',
    ' * GENERATED by `scripts/ui-docs/build.mjs --write-text`: do not edit by hand.',
    ' *',
    ' * The visible text of every page of every original under',
    ' * `client/public-ui/docs/`, keyed `<case>/<document>`, one string per page,',
    ' * lines as the page prints them. The case seeds read it for `text`, and the',
    ' * build fails when a rendered page and this text disagree.',
    ' */',
    'export const DOC_TEXT: Record<string, string[]> = {',
  ];
  for (const k of keys) {
    lines.push(`  '${k}': [`);
    for (const page of texts[k]) lines.push(`    ${JSON.stringify(page)}, ${MARKER}`);
    lines.push('  ],');
  }
  lines.push('};', '');
  writeFileSync(DOC_TEXT_FILE, lines.join('\n'));
}

function dirBytes(dir) {
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    total += s.isDirectory() ? dirBytes(p) : s.size;
  }
  return total;
}

async function render(templates) {
  const rendered = new Map();
  const browser = await chromium.launch({ timeout: 600_000 });
  try {
    const context = await browser.newContext({
      viewport: { width: 900, height: 1200 },
      deviceScaleFactor: IMAGE_WIDTH / PAGE_WIDTH_PX,
    });
    // The Mac this runs on is often loaded and the build runs at background
    // priority: generous timeouts instead of failing on a slow frame.
    context.setDefaultTimeout(600_000);
    const page = await context.newPage();
    for (const t of templates) {
      const { html, size } = compose(t.file);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);
      const pages = await page.$$eval('section.page', (els) =>
        els.map((el) => ({
          overflow: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
          text: el.innerText
            .split('\n')
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n'),
        })),
      );
      if (pages.length === 0) fail(`${t.caseId}/${t.docId}: no <section class="page">`);
      pages.forEach((p, i) => p.overflow && fail(`${t.caseId}/${t.docId} page ${i + 1}: content overflows the page`));
      const dir = join(OUT, t.caseId);
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir)) {
        if (f.startsWith(`${t.docId}-`) && /-\d+\.jpg$/.test(f) && f.slice(t.docId.length + 1, -4).match(/^\d+$/)) unlinkSync(join(dir, f));
      }
      const sections = page.locator('section.page');
      for (let i = 0; i < pages.length; i++) {
        await sections.nth(i).screenshot({
          path: join(dir, `${t.docId}-${i + 1}.jpg`),
          type: 'jpeg',
          quality: JPEG_QUALITY,
          scale: 'device',
          animations: 'disabled',
        });
      }
      const [w, h] = size.split(/\s+/);
      const pdf = await page.pdf({ width: w, height: h, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      writeFileSync(join(dir, `${t.docId}.pdf`), pdf);
      const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      if (pdfPages !== pages.length) fail(`${t.caseId}/${t.docId}: PDF has ${pdfPages} pages, the template ${pages.length}`);
      rendered.set(`${t.caseId}/${t.docId}`, pages.map((p) => p.text));
      console.log(`  ${t.caseId}/${t.docId}: ${pages.length} page(s)`);
    }
  } finally {
    await browser.close();
  }
  return rendered;
}

function check(rendered, { CASES }, renderedAll) {
  const seen = new Set();
  for (const c of CASES) {
    if (only && c.id !== only) continue;
    const docIds = new Set(c.documents.map((d) => d.id));
    for (const d of c.documents) {
      const key = `${c.id}/${d.id}`;
      seen.add(key);
      const pagesText = rendered.get(key);
      if (!pagesText) {
        fail(`${key}: no template scripts/ui-docs/templates/${key}.html`);
        continue;
      }
      const expectPages = pagesText.map((_, i) => `docs/${key}-${i + 1}.jpg`);
      if (JSON.stringify(d.pages) !== JSON.stringify(expectPages)) fail(`${key}: pages ${JSON.stringify(d.pages)} but the template has ${pagesText.length}`);
      if (d.pdf !== `docs/${key}.pdf`) fail(`${key}: pdf is ${d.pdf}`);
      for (const p of [...d.pages, d.pdf]) if (p && !existsSync(join(ROOT, 'client/public-ui', p))) fail(`${key}: missing file ${p}`);
      if (d.text.length !== pagesText.length) fail(`${key}: seed text has ${d.text.length} page(s), the document ${pagesText.length}`);
      pagesText.forEach((t, i) => {
        if (norm(t) !== norm(d.text[i] ?? '')) fail(`${key} page ${i + 1}: seed text differs from the page\n    page: ${norm(t).slice(0, 160)}\n    seed: ${norm(d.text[i] ?? '').slice(0, 160)}`);
      });
      for (const s of d.summary) if (s.page < 1 || s.page > pagesText.length) fail(`${key}: summary cites page ${s.page}`);
    }
    for (const f of c.fields) {
      const q = f.source;
      if (!docIds.has(q.doc)) {
        fail(`${c.id} field ${f.id}: quotes unknown document ${q.doc}`);
        continue;
      }
      const page = rendered.get(`${c.id}/${q.doc}`)?.[q.page - 1];
      if (page === undefined) {
        fail(`${c.id} field ${f.id}: page ${q.page} of ${q.doc} does not exist`);
        continue;
      }
      const quote = norm(`${q.before}${q.highlight}${q.after}`);
      if (!q.highlight || !norm(page).includes(quote)) fail(`${c.id} field ${f.id}: «${quote}» is not on ${q.doc} page ${q.page}`);
    }
  }
  if (renderedAll) for (const key of rendered.keys()) if (!seen.has(key)) fail(`${key}: template without a document in the seeds`);
}

const templates = listTemplates().filter((t) => !only || t.caseId === only);
if (templates.length === 0) {
  console.error('no templates to build');
  process.exit(2);
}
console.log(`rendering ${templates.length} document(s)`);
const rendered = await render(templates);

if (writeText) {
  const { DOC_TEXT } = loadSeeds();
  const merged = { ...DOC_TEXT };
  for (const [k, v] of rendered) merged[k] = v;
  if (!only) for (const k of Object.keys(merged)) if (!rendered.has(k)) delete merged[k];
  writeDocText(merged);
  console.log(`wrote ${DOC_TEXT_FILE}`);
}

check(rendered, loadSeeds(), !only);

const bytes = dirBytes(OUT);
console.log(`client/public-ui/docs: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
if (bytes > MAX_BYTES) fail(`client/public-ui/docs is ${bytes} bytes, over 8 MB`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('ok: every page matches its seed, every quote is on its page');
