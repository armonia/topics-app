#!/usr/bin/env bun
/**
 * scripts/check-tmp-canonical.ts - no literal `/tmp/` in a spec that addresses a BOARD.
 *
 * WHY IT EXISTS, and why the same defect was paid for three times
 * On macOS `/tmp` is a symlink to `/private/tmp`. The server stores a topic's
 * `projectPath` canonical (`canonicalProjectPath`, realpath) and a board id is
 * a HASH OF THAT STRING (`projectIdForPath`). So a spec that seeds its cards on
 * `boardIdForPath("/tmp/e2e-x")` and then opens the window of the folder it
 * created is looking at a different board, empty, while its own tasks sit on an
 * id nobody asks for. The failure reads as a missing card, never as a path.
 *
 * The reason it kept coming back: on the Linux runner `/tmp` IS the real
 * directory, the two spellings are the same string and the suite is green. Only
 * the laptop sees the red, which is the most expensive kind - whoever
 * reproduces a CI failure locally meets a second, unrelated one.
 *
 * WHAT IT LOOKS AT
 * Only the files that name `projectIdForPath` or `boardIdForPath`, i.e. the
 * ones where a path IS an identity. Everywhere else `/tmp/x` is a perfectly
 * good place to write a file and this gate says nothing: it is the identity
 * that breaks, not the file I/O.
 *
 * THE ESCAPE HATCH is a comment carrying `allow-literal-tmp: <reason>`, on the
 * line itself or on the one just above it, for the case that does exist: a spec
 * that hashes a path AND, elsewhere, dumps an evidence file into `/tmp`. A gate
 * with no way out gets deleted at the first legitimate exception.
 *
 * EXIT CODES
 *   0  no literal, or every one of them is excused
 *   1  at least one literal: file, line and the replacement to use
 *
 * USAGE
 *   bun run check:tmp-canonical
 *   bun run scripts/check-tmp-canonical.ts --root=<dir>   measure another checkout
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The helper every offender should be using instead. */
const REPLACEMENT = "canonicalTmpRoot() / canonicalTmpDir() from tests/e2e/helpers/file-project.ts";

/** A file whose paths are identities: it hashes them into a board id. */
const ADDRESSES_A_BOARD = /projectIdForPath|boardIdForPath/;

/** The literal, inside a string or a template: `"/tmp/x"`, `'/tmp/x'`, `` `/tmp/x` ``. */
const LITERAL_TMP = /["'`]\/tmp\//;

/** The pardon, with a reason: `// allow-literal-tmp: evidence dump`. */
const ALLOWED = /allow-literal-tmp:\s*\S/;

/** A comment line talks ABOUT the defect; it does not commit it. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

export type TmpLiteral = { file: string; line: number; text: string };

/** The offending lines of one file, already filtered for comments and pardons. */
export function literalsInSource(source: string): { line: number; text: string }[] {
  if (!ADDRESSES_A_BOARD.test(source)) return [];
  const found: { line: number; text: string }[] = [];
  const lines = source.split("\n");
  lines.forEach((raw, i) => {
    if (COMMENT_LINE.test(raw)) return;
    if (!LITERAL_TMP.test(raw)) return;
    // The pardon sits on the line, or on the one above when the line is already
    // too long to carry it: a rule that only accepts the tail forces a reason
    // out to column 200, where nobody reads it.
    if (ALLOWED.test(raw) || ALLOWED.test(lines[i - 1] ?? "")) return;
    found.push({ line: i + 1, text: raw.trim() });
  });
  return found;
}

function specFiles(root: string): string[] {
  const dir = join(root, "tests", "e2e");
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f))
    .sort();
}

export function scan(root: string): TmpLiteral[] {
  const out: TmpLiteral[] = [];
  for (const file of specFiles(root)) {
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of literalsInSource(source)) {
      out.push({ file: file.slice(root.length + 1), line: hit.line, text: hit.text });
    }
  }
  return out;
}

function main(): number {
  const rootArg = process.argv.find((a) => a.startsWith("--root="));
  const root = rootArg ? rootArg.slice("--root=".length) : join(import.meta.dir, "..");
  const hits = scan(root);
  if (hits.length === 0) {
    console.log("check:tmp-canonical: no literal /tmp/ in the specs that address a board.");
    return 0;
  }
  console.error(`check:tmp-canonical: ${hits.length} literal /tmp/ in specs that hash a path into a board id.`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text.slice(0, 120)}`);
  console.error(`\nUse ${REPLACEMENT}.`);
  console.error("If the path is NOT an identity (an evidence dump, say), put `allow-literal-tmp: <reason>` on it or just above it.");
  return 1;
}

if (import.meta.main) process.exit(main());
