#!/usr/bin/env bun
/**
 * scripts/check-ui-language.ts - fail the build when Italian reaches a text a
 * person reads in the app, or an error payload the client renders verbatim.
 *
 * THE RULE. The product ships in English: code, identifiers, scripts and the
 * strings a user sees. The app still has a real translation layer
 * (`client/src/lib/i18n.ts`, `it` + `en`), and that layer is where Italian is
 * allowed to live: it is DATA there, keyed and switchable. What is not allowed
 * is Italian hard-coded into a component or into a server payload, because that
 * string can never be switched, never be reviewed by a translator, and reaches
 * an English-speaking user as-is.
 *
 * THIS IS A RATCHET, NOT AN ABSOLUTE BAR. On the day it was written the tree
 * still held hundreds of hard-coded Italian strings across surfaces owned by
 * several people at once. An absolute gate would have been red on arrival, and
 * a gate that is born red is switched off within a week instead of obeyed. So
 * `scripts/ui-language-baseline.json` freezes today's offenders per file, and
 * the gate fails when a NEW file gains a hit or a listed file gains MORE. A
 * file that gets cured never fails: the gate prints a line asking for
 * `--update-baseline`, so the debt only ever moves down.
 *
 * WHAT IS IN SCOPE, and what deliberately is not:
 *  · IN  -> JSX text nodes in tracked `.tsx` under `client/src`, plus the four
 *    attributes a person actually reads: `title`, `aria-label`, `placeholder`,
 *    `alt`.
 *  · IN  -> string literals inside a JSX EXPRESSION CONTAINER in child
 *    position: `{'Consenti'}`, `{n ? 'Invia' : 'Avanti'}`. allow-italian: the quoted labels ARE the example. The first cut
 *    stripped every `{...}` before looking, so a label written as an
 *    expression was invisible to a gate whose whole job is labels.
 *  · IN  -> the value of a property a person reads: `label`, `message`,
 *    `hint`, `title`, `head`, `detail`, `description`, `confirmLabel`,
 *    `cancelLabel`, `placeholder`, `tooltip`. A dialog that takes its words
 *    from an object literal is not less visible than one that inlines them.
 *  · IN  -> `error:` / `detail:` / `reason:` / `message:` string values in the
 *    tracked modules under `server/routes`. Those are the payloads the client
 *    prints straight into a toast or an inline error.
 *  · IN  -> `client/src/lib/**.ts`, `client/src/hooks/**.ts` and `shared/**.ts`.
 *    A `.ts` module has no JSX, which is exactly why the copy that lives there
 *    (a decision label, a queue phrase, an error sentence) never got looked at.
 *  · OUT -> COMMENTS, always and on purpose. This repo's comments are Italian
 *    by design and there are thousands of them; policing prose in comments is a
 *    separate and much larger decision, and a gate that flagged them would be
 *    turned off within a week (the same reasoning `scripts/check-emdash.ts` and
 *    `scripts/check-script-naming.test.ts` already write down).
 *  · OUT -> test and spec files. Their strings are assertions, not copy, and
 *    several of them anchor Italian text on purpose.
 *  · OUT -> the translation catalogues themselves (`i18n*.ts`), by name now
 *    that `.ts` modules are scanned: the `it` dictionary IS the Italian, and
 *    flagging it would be flagging the feature.
 *
 * THE SECOND PASS, and why it is a different question. Italian is only half of
 * "this string cannot follow the chosen language". The other half is English
 * hard-coded in a file that ALREADY imports `useT`: the surface was migrated,
 * a later change wrote `Copy` straight into the JSX, and nothing complains
 * because the gate was only ever looking for Italian. Those hits are counted
 * as `untranslated`, in their own baseline map, because the fix is different
 * (add a key) and the debt is much larger.
 *
 * The heuristic for "prose a person reads" is deliberately tight: two words or
 * more, or one word from a short list of button verbs, capitalised, and never
 * anything that smells like an identifier, a class name, a path or a URL. One
 * false positive here costs more trust than ten missed strings, and this pass
 * runs over files that are already doing the right thing.
 *
 * HOW THE MATCH WORKS. Whole tokens against a stopword list, never substrings:
 * "alter" must not trip on "alt", "content" must not trip on "con", and a
 * proper noun must not trip at all. Two signals count as Italian: a token that
 * is in the list, or a grave-accented vowel, which English UI copy does not
 * use. Words that exist in BOTH languages are deliberately absent from the list
 * ("pane", "fine", "state", "come", "solo", "per", "media", "dove", "alto",
 * "ore", "usa"): each of them is a real English word this repo already uses,
 * and one false positive costs more trust than ten missed strings.
 *
 * ESCAPE HATCH, for the case where the Italian IS the data: a fixture, a
 * parser, a label the server and the client compare BY VALUE. Suffix the line
 * with `// allow-italian: <why>`. The marker is honoured on the offending line
 * and on the line the literal opens on, so a multi-line template only needs it
 * once.
 *
 * NO AST, on purpose: the root has no `typescript` installed, and a lexer that
 * knows comments, strings, template literals and regex literals is enough to
 * tell a JSX text node from code in this codebase.
 *
 * EXIT CODES
 *   0  within the baseline (or, in absolute mode, no hit at all)
 *   1  over: a new file, a file that grew, or in absolute mode any hit
 *   2  the measurement could not be taken (no git, unreadable baseline)
 *
 * USAGE
 *   bun run check:ui-language                       ratchet against the baseline
 *   bun run check:ui-language --absolute            every hit, baseline ignored
 *   bun run check:ui-language --json                machine readable
 *   bun run check:ui-language --update-baseline     rewrite the baseline
 *   bun run scripts/check-ui-language.ts a.tsx b.ts scan those files, absolute
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { ALLOW, I18N_CATALOGUES, scanFile, type Hit } from "./ui-language-scan";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_PATH = resolve(ROOT, "scripts/ui-language-baseline.json");

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

const IS_TEST = /\.(test|spec|e2e)\.[cm]?tsx?$/;

/**
 * EVERY tracked `.ts` under `client/src` is in scope, not just `lib` and
 * `hooks`. The first cut named those two directories and missed exactly the
 * modules the bug report was about: `components/Browser/navErrorMessage.ts`
 * and `components/Chat/useVoiceRecording.ts` are plain modules that live
 * beside the component that uses them, and a scope written by directory name
 * declared them out of the product.
 */
function inScope(p: string): boolean {
  if (IS_TEST.test(p)) return false;
  if (I18N_CATALOGUES.has(p)) return false;
  if (p.endsWith(".tsx")) return p.startsWith("client/src/");
  if (!p.endsWith(".ts")) return false;
  return p.startsWith("client/src/") || p.startsWith("server/routes/") || p.startsWith("shared/");
}

function trackedFiles(): string[] {
  const git = spawnSync("git", ["ls-files", "-z", "client/src", "server/routes", "shared"], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (git.status !== 0) {
    console.error("[check-ui-language] cannot list tracked files: is this a git checkout?");
    process.exit(2);
  }
  return git.stdout.split("\0").filter(Boolean).filter(inScope);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface Baseline {
  $schema: string;
  _comment: string[];
  updated: string;
  /** path -> hard-coded ITALIAN hits the day recorded. Absent means "stay at 0". */
  files: Record<string, number>;
  /** path -> hard-coded ENGLISH hits in a file that already imports `useT`. */
  untranslated: Record<string, number>;
}

const BASELINE_COMMENT = [
  "Frozen debt for scripts/check-ui-language.ts. One entry per file that still",
  "holds hard-coded Italian in a text a person reads, with how many hits it had",
  "the day it was recorded.",
  "",
  "THE GATE IS A RATCHET. A file that is not listed here must have ZERO hits; a",
  "file that is listed must not gain more. Curing a file never fails the gate:",
  "it prints a line asking for `--update-baseline`, and the number here only",
  "ever goes down.",
  "",
  "The numbers are a SNAPSHOT of the day they were taken, not an allowance:",
  "several surfaces were mid-translation when this was first frozen. Re-run",
  "`--update-baseline` after a sweep so the debt on record is the real one.",
  "",
  "LOWERING A NUMBER is free and expected. RAISING one is not: translate the",
  "string, or if the Italian IS the data (a fixture, a parser, a label compared",
  "by value across the client/server boundary) mark that line with",
  "`// allow-italian: <why>` instead of buying the exemption here.",
  "",
  "TWO MAPS, TWO DEFECTS. `files` counts hard-coded ITALIAN: a string an",
  "English-speaking user reads in the wrong language. `untranslated` counts",
  "hard-coded ENGLISH inside a file that already imports `useT`: the surface was",
  "migrated and a later change wrote the label straight into the JSX, so the",
  "language selector silently stops governing it. The fix differs (translate vs",
  "add a key), so the debt is counted apart.",
];

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const files = (parsed as { files?: unknown }).files;
    if (files === null || typeof files !== "object") return null;
    const body = parsed as Baseline;
    // A v1 baseline has no second map: an absent map is an empty one, so an
    // older file still reads and every untranslated hit shows up as new.
    body.untranslated ??= {};
    return body;
  } catch (err) {
    console.error(`[check-ui-language] baseline unreadable: ${String(err)}`);
    process.exit(2);
  }
  return null;
}

function sortedMap(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key)!;
  return out;
}

function writeBaseline(italian: Map<string, number>, untranslated: Map<string, number>): void {
  const body: Baseline = {
    $schema: "ui-language-baseline-v2",
    _comment: BASELINE_COMMENT,
    updated: new Date().toISOString().slice(0, 10),
    files: sortedMap(italian),
    untranslated: sortedMap(untranslated),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[check-ui-language] baseline written: ${italian.size} file(s) with ${total(italian)} Italian hit(s), ` +
      `${untranslated.size} file(s) with ${total(untranslated)} untranslated hit(s).`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const update = argv.includes("--update-baseline");
  const explicit = argv.filter((a) => !a.startsWith("--"));
  const absolute = argv.includes("--absolute") || explicit.length > 0;

  const files = explicit.length > 0 ? explicit.map((p) => relative(ROOT, resolve(p))) : trackedFiles();

  const hits: Hit[] = [];
  for (const file of files) hits.push(...scanFile(file));

  const italianHits = hits.filter((h) => h.kind === "italian");
  const untranslatedHits = hits.filter((h) => h.kind === "untranslated");
  const countBy = (list: Hit[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const h of list) m.set(h.file, (m.get(h.file) ?? 0) + 1);
    return m;
  };
  const counts = countBy(italianHits);
  const untranslatedCounts = countBy(untranslatedHits);

  if (update) {
    if (absolute) {
      console.error("[check-ui-language] --update-baseline needs the full tracked scan, not a file list.");
      process.exit(2);
    }
    writeBaseline(counts, untranslatedCounts);
    process.exit(0);
  }

  const report = (list: Hit[]): void => {
    const grouped = new Map<string, Hit[]>();
    for (const h of list) {
      const acc = grouped.get(h.file) ?? [];
      acc.push(h);
      grouped.set(h.file, acc);
    }
    for (const [file, rows] of grouped) {
      console.error(`\n  ${file}`);
      for (const r of rows) {
        const why = r.kind === "italian" ? r.words.join(" ") : "not keyed";
        console.error(`    :${r.line}  [${r.where}] ${why} | ${r.text}`);
      }
    }
  };

  if (absolute) {
    if (json) console.log(JSON.stringify({ mode: "absolute", files: files.length, hits }, null, 2));
    if (hits.length === 0) {
      if (!json) console.log(`[check-ui-language] OK (absolute): ${files.length} file(s), every app text is keyed.`);
      process.exit(0);
    }
    if (!json) {
      console.error(
        `[check-ui-language] FAIL (absolute): ${italianHits.length} Italian string(s) and ` +
          `${untranslatedHits.length} unkeyed string(s).`,
      );
      report(hits);
      console.error(`\nPut them through i18n, or mark the line with '// ${ALLOW} <why>' when the string IS the data.`);
    }
    process.exit(1);
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error(
      `[check-ui-language] no baseline at ${relative(ROOT, BASELINE_PATH)}. ` +
        `Run 'bun run check:ui-language --update-baseline' once to freeze today's debt.`,
    );
    process.exit(2);
  }

  interface Move { file: string; was: number; now: number }
  interface Verdict { newFiles: string[]; grown: Move[]; cured: Move[] }

  /** The ratchet, one family at a time: new file or grown file fails, cured is free. */
  const compare = (now: Map<string, number>, was: Record<string, number>): Verdict => {
    const v: Verdict = { newFiles: [], grown: [], cured: [] };
    for (const [file, count] of now) {
      const before = was[file];
      if (before === undefined) v.newFiles.push(file);
      else if (count > before) v.grown.push({ file, was: before, now: count });
      else if (count < before) v.cured.push({ file, was: before, now: count });
    }
    for (const [file, before] of Object.entries(was)) {
      if (!now.has(file)) v.cured.push({ file, was: before, now: 0 });
    }
    return v;
  };

  const italian = compare(counts, baseline.files);
  const untranslated = compare(untranslatedCounts, baseline.untranslated);

  if (json) {
    console.log(JSON.stringify({ mode: "ratchet", files: files.length, italian, untranslated, hits }, null, 2));
  }

  const failing =
    italian.newFiles.length + italian.grown.length + untranslated.newFiles.length + untranslated.grown.length > 0;

  if (!failing) {
    if (!json) {
      console.log(
        `[check-ui-language] OK: ${files.length} file(s) scanned, ` +
          `${italianHits.length} known Italian hit(s) in ${counts.size} file(s), ` +
          `${untranslatedHits.length} known unkeyed hit(s) in ${untranslatedCounts.size} file(s).`,
      );
      const cured = [...italian.cured, ...untranslated.cured];
      if (cured.length > 0) {
        console.log(
          `[check-ui-language] ${cured.length} file(s) improved. ` +
            `Lock it in with 'bun run check:ui-language --update-baseline'.`,
        );
        for (const c of cured.slice(0, 20)) console.log(`    ${c.file}: ${c.was} -> ${c.now}`);
      }
    }
    process.exit(0);
  }

  if (!json) {
    console.error("[check-ui-language] FAIL: a text a person reads does not follow the chosen language.");
    const groups: [string, Verdict, Hit[]][] = [
      ["hard-coded Italian", italian, italianHits],
      ["copy that does not go through i18n", untranslated, untranslatedHits],
    ];
    for (const [what, verdict, family] of groups) {
      if (verdict.newFiles.length > 0) {
        console.error(`\n${verdict.newFiles.length} file(s) NOT in the baseline gained ${what}:`);
        report(family.filter((h) => verdict.newFiles.includes(h.file)));
      }
      if (verdict.grown.length > 0) {
        console.error(`\n${verdict.grown.length} baselined file(s) gained MORE ${what}:`);
        for (const g of verdict.grown) console.error(`  ${g.file}: ${g.was} -> ${g.now}`);
        report(family.filter((h) => verdict.grown.some((g) => g.file === h.file)));
      }
    }
    console.error(
      `\nThe app ships in the language the person chose. Put the string through` +
        `\n'client/src/lib/i18n.ts' and add the key to BOTH catalogues. If the string IS` +
        `\nthe data (a fixture, a parser, a label the server and the client compare by` +
        `\nvalue), end the line with '// ${ALLOW} <why>'. Do not raise a baseline number.`,
    );
  }
  process.exit(1);
}

main();
