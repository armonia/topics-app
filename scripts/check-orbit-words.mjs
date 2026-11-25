#!/usr/bin/env node
/**
 * scripts/check-orbit-words.mjs - exit 1 when the ORBIT edition names a thing
 * with a word the glossary has retired.
 *
 * WHY. Attilio (08/11): «Non lo chiamerei funnel: si chiamano flussi,
 * assicuriamoci che ci sia coerenza in tutto». One concept, one name, on every
 * screen: a card is not also a «pratica» or a «ticket», a column of the
 * kanban is a «stato», not a «fase», the people who work together are a
 * «team», not an «ufficio» or a «reparto». The glossary is
 * `topics-app-mockup-flussi/brief/glossario-orbit.md`; the words below are
 * its «non si dice» column, and this gate keeps them from coming back.
 *
 * TWO TIERS.
 *  · RETIRED everywhere (`funnel`): sources of the preview, identifiers and
 *    comments included (the address, a data attribute, a screen id, a chunk
 *    name are all «visible code»), the scripts that drive it, the build in
 *    `client/dist-ui/` and the names of the captures in
 *    `topics-app-mockup-flussi/png-reale/orbit/`.
 *  · SYNONYMS of a word the glossary keeps: only in the Italian words of the
 *    ORBIT interface (`client/src/ui/copy/i18n-ui-{kanban,orbit-*,contracts,
 *    filters}-it.ts`), where they would name our own things; the text of a real
 *    document (a law, a mail in a card's original) may still say «pratica».
 *
 * The step names of the flows (`client/src/ui/fixtures/orbit-org/flows.ts` and
 * `nocera-org/flows.ts`, so the glossary holds for both editions)
 * are read too, with «controllo» added: a step of a person is «verifica».
 *
 *   node scripts/check-orbit-words.mjs [--src-only]
 *
 * Exit 0: no retired word, with the counts read. Exit 1: `file:line - word`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcOnly = process.argv.includes("--src-only");
/* The captures live in the mockup repo next to this one; absent on a runner, where only the sources and the build are read. */
const SHOTS = join(homedir(), "Projects/topics-app-mockup-flussi/png-reale/orbit");

/** Retired from everything. */
const RETIRED = [/funnel/i];

/** Synonyms of a kept word, in the Italian words of the interface: [pattern, the word to use]. */
const SYNONYMS = [
  [/\bfunnel\b/i, "flusso"],
  [/\bpipeline\b/i, "flusso"],
  [/\bandament[oi]\b/i, "«Per stato»"],
  [/\bfas[ei]\b/i, "stato (le colonne: In arrivo, In lavorazione, Da verificare, Da approvare, Fatto)"],
  [/\bstep\b/i, "passo"],
  [/\bpratic(a|he)\b/i, "card"],
  [/\bticket\b/i, "card"],
  [/\btask\b/i, "card"],
  [/\b(ufficio|uffici|reparto|reparti)\b/i, "team"],
  [/\bbozz[ae] e controllo\b|\bultima parola\b/i, "niente slogan: ogni testo porta un'informazione o un'azione"],
  /* «Ferma» is the state of a card that waits too long or on something outside; «bloccata» as a label of its own is a second name for it. A whole string, so «Bozza bloccata» of a contract (another thing) passes. */
  [/^\s*bloccat[aeio](\s+da\b.*)?\s*$/i, "ferma (Ferma da 2 g)"],
  /* The two steps a person takes before a card moves on are «verifica» and «approvazione»; «controlla» and «revisione» are not their names. */
  [/\b(chi|che|la|lo|li|le) controll(a|ano)\b|\brevision[ei]\b/i, "verifica (Verifica di, la verifica); per un contratto: versione"],
  [/\b(fiducia|confidenza|affidabilità)\b/i, "sicurezza (sicurezza 97%)"],
  /* Permissions are given to a team (Vede, Lavora, Gestisce), with exceptions per person: ORBIT has no «ruoli». */
  /* «Catasto e ruoli» is the proper name of a team of the Consorzio (the tax rolls of its members), not the word for permissions. */
  [/(?<!catasto e )\bruol[oi]\b/i, "team (permessi per team: Vede, Lavora, Gestisce)"],
];

/** Words of a step of a flow, in the fixtures: a step of type «verifica» is not said with «controllo». */
const FIXTURE_ONLY = [
  [/\bcontroll(a|ano|o|i)\b/i, "verifica"],
];

const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (!ext || ext.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const hits = [];
const lineOf = (text, i) => text.slice(0, i).split("\n").length;

/** Every match of the retired words in a file, identifiers and comments included. */
function scanRetired(file, label = rel(file)) {
  const text = readFileSync(file, "utf8");
  for (const re of RETIRED) {
    for (const m of text.matchAll(new RegExp(re.source, "gi"))) hits.push(`${label}:${lineOf(text, m.index)} - «${m[0]}» (retired: «flusso»)`);
  }
}

/** The string literals of a TS file, with where they start: the words a screen shows. */
function stringsOf(text) {
  const out = [];
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  /* Comments are blanked first, so an English comment that says «step» is not read as a word of the interface. */
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(^|[^:\\])\/\/.*$/gm, (c, p) => p + " ".repeat(c.length - p.length));
  for (const m of code.matchAll(re)) out.push({ s: m[0].slice(1, -1), at: m.index });
  return out;
}

/* ---------- retired everywhere ---------- */

const SOURCE_DIRS = ["client/src/ui", "client/src/ui-gallery"].map((d) => join(ROOT, d));
const sources = SOURCE_DIRS.flatMap((d) => walk(d, [".ts", ".tsx", ".css"]));
const scripts = walk(join(ROOT, "scripts"), [".mjs", ".ts"]).filter((f) => /\/(ui-[^/]*|check-orbit-words\.mjs)$/.test(f) || f.includes(`${sep}ui-app${sep}`) || f.includes(`${sep}ui-fixtures${sep}`));
for (const f of [...sources, ...scripts]) {
  if (f.endsWith("check-orbit-words.mjs")) continue;
  scanRetired(f);
}
for (const f of ["client/orbit.html", "client/consorzio.html", "client/app.html", "client/ui.html"].map((p) => join(ROOT, p)).filter(existsSync)) scanRetired(f);

let buildFiles = 0;
if (!srcOnly) {
  const dist = join(ROOT, "client/dist-ui");
  for (const page of ["orbit.html", "consorzio.html"]) {
    if (!existsSync(join(dist, page))) {
      console.error(`check-orbit-words: client/dist-ui/${page} is missing, run \`bun run build:ui\` first (or pass --src-only).`);
      process.exit(1);
    }
  }
  for (const f of walk(dist)) {
    buildFiles++;
    if (RETIRED.some((re) => re.test(basename(f)))) hits.push(`${rel(f)} - file name`);
    if (/\.(js|css|html|json|txt|md)$/.test(f)) scanRetired(f);
  }
}

let shots = 0;
if (existsSync(SHOTS)) {
  for (const f of walk(SHOTS)) {
    shots++;
    const name = relative(SHOTS, f);
    if (RETIRED.some((re) => re.test(name))) hits.push(`png-reale/orbit/${name} - file name`);
    if (/\.(json|md|txt)$/.test(f)) scanRetired(f, `png-reale/orbit/${name}`);
  }
}

/* ---------- synonyms, in the Italian words of the ORBIT interface ---------- */

const COPY = join(ROOT, "client/src/ui/copy");
const orbitCopy = readdirSync(COPY).filter((n) => /^i18n-ui-(kanban|orbit-[a-z-]+|contracts|filters)-it\.ts$/.test(n)).map((n) => join(COPY, n));
let words = 0;
for (const f of orbitCopy) {
  const text = readFileSync(f, "utf8");
  for (const { s, at } of stringsOf(text)) {
    words++;
    for (const [re, use] of SYNONYMS) {
      const m = s.match(re);
      if (m) hits.push(`${rel(f)}:${lineOf(text, at)} - «${m[0]}» in «${s.slice(0, 70)}»: use ${use}`);
    }
  }
}

/* The same words in the fixtures that name the steps of the flows: the copy files do not hold them, the screens print them. */
const fixtureFiles = ["client/src/ui/fixtures/orbit-org/flows.ts", "client/src/ui/fixtures/nocera-org/flows.ts"].map((p) => join(ROOT, p)).filter(existsSync);
for (const f of fixtureFiles) {
  const text = readFileSync(f, "utf8");
  for (const { s, at } of stringsOf(text)) {
    words++;
    for (const [re, use] of [...SYNONYMS, ...FIXTURE_ONLY]) {
      const m = s.match(re);
      if (m) hits.push(`${rel(f)}:${lineOf(text, at)} - «${m[0]}» in «${s.slice(0, 70)}»: use ${use}`);
    }
  }
}

if (!sources.length || !orbitCopy.length || !words) {
  console.error("check-orbit-words: read zero files: a gate that scans nothing is green by accident.");
  process.exit(1);
}
if (hits.length) {
  console.error(`check-orbit-words: ${hits.length} retired words:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-orbit-words: ok, ${sources.length + scripts.length} sources${srcOnly ? "" : `, ${buildFiles} files of the build`}, ${shots} captures, ${words} strings of ${orbitCopy.length} copy files and ${fixtureFiles.length} fixture files (the flows of ORBIT and of the Consorzio): no retired word`);
