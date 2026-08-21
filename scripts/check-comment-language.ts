#!/usr/bin/env bun
/**
 * scripts/check-comment-language.ts - fail the build when NEW Italian prose
 * reaches a code comment.
 *
 * THE RULE, as of 2026-08-21. The codebase is English: identifiers, strings a
 * person reads, and comments. Comments were deliberately out of scope for
 * `scripts/check-ui-language.ts`, and that script says why in its own header:
 * "policing prose in comments is a separate and much larger decision, and a
 * gate that flagged them would be turned off within a week". The decision has
 * since been made; what has not changed is the arithmetic behind that warning.
 * Thousands of comments in this tree are Italian, and an absolute bar would be
 * red on arrival.
 *
 * SO THIS IS A RATCHET, and it is born green. `comment-language-baseline.json`
 * freezes today's count per file. The gate fails when an unlisted file gains a
 * hit, or a listed file gains MORE than it had. Translating a file is always
 * safe: the gate prints a line asking for `--update-baseline`, so the debt only
 * ever moves down. There is no deadline and no bulk translation: comments get
 * rewritten in English when the code around them is touched anyway, which is
 * also when the person editing understands what the comment was protecting.
 *
 * WHY LINES AND NOT FILES. The unit is the comment LINE, so a 40-line Italian
 * header that gets half rewritten shows up as progress instead of standing
 * still until the last word is gone. It also means a file can be cured in
 * passes, which is the only way a 20k-line debt actually gets paid.
 *
 * SCOPE. Tracked `.ts` / `.tsx` / `.rs` under `client/src`, `server`, `shared`,
 * `scripts`, `tests`, and `desktop-tauri/src-tauri/src`. Comments only: string
 * and template literals are stripped before the scan, so an Italian string is
 * this gate's business only through `check:ui-language`.
 *
 * ESCAPE HATCH. `allow-italian: <why>` on the comment line, the same marker
 * `check:ui-language` already honours. It exists for the case where the Italian
 * IS the subject - a quoted error message, a term of art with no English
 * equivalent, a verbatim quote from a person.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ACCENTS, STOPWORDS } from "./ui-language-words";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts", "comment-language-baseline.json");
const ALLOW = "allow-italian:";

const ROOTS = [
  "client/src",
  "server",
  "shared",
  "scripts",
  "tests",
  "desktop-tauri/src-tauri/src",
];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|rs)$/.test(f))
    .filter((f) => !f.endsWith(".d.ts"));
}

/**
 * Comment text, line by line, with strings already gone.
 *
 * A hand-rolled scanner and not a regex: `"// not a comment"` inside a string
 * and `/* ` inside a template literal both have to stay invisible, and a regex
 * cannot carry that state. Returns one entry per source line that carries
 * comment text, so the caller can report a real line number.
 *
 * The one thing it gets wrong on purpose is a regex literal that contains an
 * escaped `//` (`/\/\//`). Telling division from a regex needs a parser, and
 * the cost of the miss is one over-counted line in a ratchet, which the
 * baseline absorbs.
 */
export function commentLines(src: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let line = 1;
  let i = 0;
  const n = src.length;
  const push = (l: number, t: string) => {
    if (t.trim()) found.push({ line: l, text: t });
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    // Strings: skip whole, honouring escapes. Templates can span lines.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") line++;
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const start = i + 2;
      let j = start;
      while (j < n && src[j] !== "\n") j++;
      push(line, src.slice(start, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      let lineStart = j;
      const at = line;
      let cur = at;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) {
        if (src[j] === "\n") {
          push(cur, src.slice(lineStart, j));
          cur++;
          line++;
          lineStart = j + 1;
        }
        j++;
      }
      push(cur, src.slice(lineStart, Math.min(j, n)));
      i = Math.min(j + 2, n);
      continue;
    }
    i++;
  }
  return found;
}

/**
 * The same verdict `check:ui-language` uses, so the two gates never disagree -
 * plus one subtraction that only comments need.
 *
 * `non-` IS ENGLISH HERE. "non-empty", "non-null", "non-zero", "non-blocking"
 * are ordinary English technical prose and they are everywhere in this tree's
 * comments, but tokenising on the hyphen hands back "non", which is one of the
 * commonest Italian words. `check:ui-language` hit the same wall and wrote it
 * down (see its `italianWords`); it could afford to keep the hit because UI
 * copy rarely says "non-empty". Comments say it constantly, so the compound is
 * removed before the scan. The bare word "non" still counts.
 */
export function italianWords(raw: string): string[] {
  const found = new Set<string>();
  const text = raw.replace(/\bnon-(?=[a-z])/gi, "");
  if (ACCENTS.test(text)) found.add("<accent>");
  for (const token of text.toLowerCase().split(/[^a-zàèéìòùA-ZÀÈÉÌÒÙ]+/)) {
    if (token.length >= 3 && STOPWORDS.has(token)) found.add(token);
  }
  return [...found];
}

type Hit = { file: string; line: number; words: string[]; text: string };

function scan(): { hits: Hit[]; perFile: Map<string, number> } {
  const hits: Hit[] = [];
  const perFile = new Map<string, number>();
  for (const file of trackedFiles()) {
    let src: string;
    try {
      src = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    if (!src.includes("//") && !src.includes("/*")) continue;
    for (const { line, text } of commentLines(src)) {
      if (text.includes(ALLOW)) continue;
      const words = italianWords(text);
      if (!words.length) continue;
      hits.push({ file, line, words, text: text.trim().slice(0, 90) });
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
  }
  return { hits, perFile };
}

type Baseline = { $schema: string; _comment: string[]; files: Record<string, number> };

function readBaseline(): Baseline["files"] {
  if (!existsSync(BASELINE)) return {};
  return (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline).files ?? {};
}

function writeBaseline(perFile: Map<string, number>): void {
  const files: Record<string, number> = {};
  for (const k of [...perFile.keys()].sort()) files[k] = perFile.get(k)!;
  const doc: Baseline = {
    $schema: "comment-language-baseline-v1",
    _comment: [
      "Frozen debt for scripts/check-comment-language.ts. One entry per file",
      "that still holds Italian in a comment, with how many comment LINES had it",
      "the day it was recorded.",
      "",
      "THE GATE IS A RATCHET. A file that is not listed here must have ZERO",
      "Italian comment lines; a file that is listed must not gain more. Curing a",
      "file never fails the gate - rerun with --update-baseline to record the",
      "lower number, and it can never go back up.",
      "",
      "Do not hand-edit a count upwards. If a change genuinely needs Italian in a",
      "comment (a quoted message, a term of art), mark that line with",
      "`allow-italian: <why>` instead.",
    ],
    files,
  };
  writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + "\n");
}

/* The scan runs only when this file IS the process, so `check-comment-language.test.ts`
 * can import the two pure functions without the gate scanning the whole tree
 * (and calling `process.exit`) as a side effect of the import. */
const isMain = import.meta.main;
const update = isMain && process.argv.includes("--update-baseline");
const list = isMain && process.argv.includes("--list");
const { hits, perFile } = isMain ? scan() : { hits: [] as Hit[], perFile: new Map<string, number>() };

/* `--list` prints the flagged lines themselves. Paying the debt down means
 * reading them, and a count with no way to see what it counted is a number
 * nobody can act on - or check. */
if (list) {
  const only = process.argv[process.argv.indexOf("--list") + 1];
  const shown = only && !only.startsWith("--") ? hits.filter((h) => h.file.includes(only)) : hits;
  for (const h of shown.slice(0, 400)) {
    console.log(`${h.file}:${h.line}  [${h.words.join(",")}]  ${h.text}`);
  }
  console.log(`\n${shown.length} line(s)${shown.length > 400 ? " (first 400 shown)" : ""}.`);
  process.exit(0);
}

if (update) {
  writeBaseline(perFile);
  const total = [...perFile.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[check-comment-language] baseline written: ${perFile.size} file(s), ${total} comment line(s).`,
  );
  process.exit(0);
}

if (!isMain) { /* imported by the test: nothing else to do. */ } else {

const base = readBaseline();
const regressions: string[] = [];
for (const [file, count] of perFile) {
  const allowed = base[file] ?? 0;
  if (count > allowed) {
    const worse = hits.filter((h) => h.file === file).slice(0, 3);
    regressions.push(
      `  ${file}: ${count} Italian comment line(s), baseline ${allowed}\n` +
        worse.map((h) => `      ${h.file}:${h.line}  ${h.text}`).join("\n"),
    );
  }
}

const cured = Object.entries(base).filter(([f, n]) => (perFile.get(f) ?? 0) < n);

if (regressions.length) {
  console.error("[check-comment-language] NEW Italian in comments:\n");
  console.error(regressions.join("\n"));
  console.error(
    "\nThe standard is English, comments included. Rewrite the comment in English,\n" +
      `or mark the line \`${ALLOW} <why>\` when the Italian IS the subject.\n` +
      "Do not raise the baseline: it only moves down.",
  );
  process.exit(1);
}

const total = [...perFile.values()].reduce((a, b) => a + b, 0);
const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
console.log(
  `[check-comment-language] OK - ${total} Italian comment line(s) in ${perFile.size} file(s), baseline ${baseTotal}.`,
);
if (cured.length) {
  console.log(
    `[check-comment-language] ${cured.length} file(s) improved. Run with --update-baseline to lock it in:`,
  );
  for (const [f, n] of cured.slice(0, 10)) console.log(`    ${f}: ${n} -> ${perFile.get(f) ?? 0}`);
}

}
