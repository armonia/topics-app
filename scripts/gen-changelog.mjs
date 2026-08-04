#!/usr/bin/env node
/**
 * gen-changelog — regenerate the changelog from git history.
 *
 *   bun run changelog            # or: node scripts/gen-changelog.mjs [ref]
 *
 * Reads the commit history + version-file boundaries from git, builds the
 * structured changelog (scripts/changelog-lib.mjs), joins the EN translations
 * from scripts/changelog-i18n.json, and writes:
 *   - CHANGELOG.md                     canonical, Italian
 *   - client/public/changelog.json     structured (it+en, all buckets) -> served at /changelog.json
 *   - landing/src/data/changelog.json  public site (EN, new/fixes/perf only)
 *
 * Any user-facing entry (new/fixes/perf) missing an EN translation is reported so
 * it can be added to changelog-i18n.json. Regeneration is deterministic.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangelog, renderMarkdown } from './changelog-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF = process.argv[2] || 'HEAD';
const VERSION_FILE = 'desktop-tauri/src-tauri/tauri.conf.json';

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const versionInBlob = (spec) => {
  const m = git('show', spec).match(/"version"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
};

// 1. Commit history, oldest → newest (merges excluded — they never carry entries).
const commits = git('log', REF, '--reverse', '--no-merges', '--pretty=%H%x09%ad%x09%s', '--date=short')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [hash, date, ...rest] = line.split('\t');
    return { hash, date, subject: rest.join('\t') };
  });

// 2. Version boundaries: commits that CHANGED the version in the lockstep file.
const touchers = git('log', REF, '--reverse', '--pretty=%H', '--', VERSION_FILE).trim().split('\n').filter(Boolean);
const boundaryMap = new Map();
let lastVersion = null;
for (const hash of touchers) {
  const v = versionInBlob(`${hash}:${VERSION_FILE}`);
  if (v && v !== lastVersion) {
    boundaryMap.set(hash, v);
    lastVersion = v;
  }
}

// 3. Current version in the working tree (for trailing, not-yet-bumped work).
const currentVersion =
  JSON.parse(readFileSync(resolve(ROOT, VERSION_FILE), 'utf8')).version ||
  JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

// 4. Build.
const versions = buildChangelog(commits, boundaryMap, currentVersion);

// 5. Join EN translations.
const I18N_PATH = resolve(ROOT, 'scripts/changelog-i18n.json');
const i18n = existsSync(I18N_PATH) ? JSON.parse(readFileSync(I18N_PATH, 'utf8')) : {};
const missing = [];
const PUBLIC_BUCKETS = ['new', 'fixes', 'perf'];
for (const v of versions) {
  for (const bucket of Object.keys(v.sections)) {
    for (const entry of v.sections[bucket]) {
      entry.en = i18n[entry.it] || '';
      if (!entry.en && PUBLIC_BUCKETS.includes(bucket)) missing.push(entry.it);
    }
  }
}

// 6. Write outputs.
const write = (rel, content) => {
  const abs = resolve(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};

write('CHANGELOG.md', renderMarkdown(versions) + '\n');

// In-app: full structured (it + en, every bucket). Served as a static asset at
// /changelog.json (not bundled into the JS) and fetched lazily by ChangelogModal.
const appJson = versions.map((v) => ({
  version: v.version,
  date: v.date,
  sections: v.sections,
}));
write('client/public/changelog.json', JSON.stringify(appJson, null, 2) + '\n');

/**
 * Scopes come straight off the conventional-commit subject, so the ones written
 * in Italian used to reach the English site verbatim: a translated entry still
 * carried a `costi ·` or `notifiche ·` label in front of it. Only the Italian
 * scopes need an entry here — anything absent passes through unchanged, which
 * is right for the technical ones (`pty`, `worktree`, `mcp`, …) that are the
 * same word in both languages.
 */
const SCOPE_EN = {
  agenti: 'agents', attenzione: 'attention', coda: 'queue', contesto: 'context',
  'contratto ws': 'ws contract', costi: 'costs', diagnostica: 'diagnostics',
  evidenza: 'evidence', guardia: 'guard', guscio: 'shell', icone: 'icons',
  memoria: 'memory', messaggi: 'messages', modali: 'modals', notifiche: 'notifications',
  osservabilita: 'observability', processi: 'processes', rigenera: 'regenerate',
  sessioni: 'sessions', sicurezza: 'security', tastiera: 'keyboard', tempi: 'timing',
  terminale: 'terminal', voce: 'voice',
};
const scopeEn = (s) => (s ? SCOPE_EN[s] || s : s);

/**
 * Em dashes out, for the PUBLIC SITE ONLY.
 *
 * Release notes here come from commit subjects, and the commit style is
 * "scope — what changed", so 298 of them arrived on the site carrying an em
 * dash. That is 299 of the 408 em dashes in 44,310 words of published copy, and
 * a density of em dashes is one of the listed tells of machine-written prose —
 * on a site whose credibility rests on a person having written it.
 *
 * The shape is uniform enough to transform safely: every one of the 298 is a
 * single space-wrapped dash separating a subject from its explanation, which is
 * a colon. Where the subject already contains a colon, a comma instead, so the
 * line does not end up with two.
 *
 * CHANGELOG.md and the in-app changelog keep their dashes: this is about how the
 * public site reads, not about rewriting the repository's own history.
 */
function undash(text) {
  return String(text).replace(/ — /g, (_m, i, s) => (s.slice(0, i).includes(':') ? ', ' : ': '));
}

/**
 * Empty adjectives, same reasoning, same scope: public site only.
 *
 * "robust" carries no information in any of the four entries that use it —
 * "robust Chromium cleanup" is Chromium cleanup — and it is on the list of
 * words that make prose read as generated. Deleting it costs the sentence
 * nothing, which is the test for whether an adjective was doing work.
 *
 * Deliberately NOT here: `vibrancy`. That is NSVisualEffectView's own name for
 * the effect, it appears twenty times, and every one of them is correct.
 */
function deflate(text) {
  return String(text).replace(/\brobust\s+/gi, '');
}

// Public site: EN only, user-facing buckets, drop internal churn. Fallback to IT
// so a not-yet-translated entry still shows rather than vanishing.
const siteJson = versions
  .map((v) => ({
    version: v.version,
    date: v.date,
    sections: {
      new: v.sections.new.map((e) => ({ text: deflate(undash(e.en || e.it)), scope: scopeEn(e.scope) })),
      fixes: v.sections.fixes.map((e) => ({ text: deflate(undash(e.en || e.it)), scope: scopeEn(e.scope) })),
      perf: v.sections.perf.map((e) => ({ text: deflate(undash(e.en || e.it)), scope: scopeEn(e.scope) })),
    },
  }))
  .filter((v) => v.sections.new.length + v.sections.fixes.length + v.sections.perf.length > 0);
// `landing/src/data/`, not `landing/`. The site became an Astro project and
// this line kept writing to a path nothing reads, so the next regeneration
// would have silently frozen the public changelog at whatever version was last
// copied by hand — no error anywhere, just a page that stopped moving.
//
// It is a build INPUT now, not a public asset: the page imports it and renders
// the list server-side, so the 250KB never reaches a browser at all.
write('landing/src/data/changelog.json', JSON.stringify(siteJson, null, 2) + '\n');

// 7. Report.
const totalEntries = versions.reduce(
  (n, v) => n + v.sections.new.length + v.sections.fixes.length + v.sections.perf.length + v.sections.internal.length,
  0,
);
console.log(`✓ ${versions.length} versioni, ${totalEntries} voci — CHANGELOG.md + 2× changelog.json`);
if (missing.length) {
  const uniq = [...new Set(missing)];
  write('scripts/.changelog-missing-en.json', JSON.stringify(Object.fromEntries(uniq.map((s) => [s, ''])), null, 2) + '\n');
  console.log(`⚠ ${uniq.length} voci new/fixes/perf senza traduzione EN → scripts/.changelog-missing-en.json`);
} else {
  console.log('✓ tutte le voci pubbliche hanno una traduzione EN');
}
