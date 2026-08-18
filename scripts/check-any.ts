#!/usr/bin/env bun
/**
 * scripts/check-any.ts — fail the build when a tracked file contains `: any`.
 *
 * Slice 8 of the picker/snapshot/tool-call refactor introduced this. It runs
 * over a hard-coded list of "touched" files (the ones we own) and exits 1 if
 * any of them re-introduce a hand-written `any` annotation. Auto-formatted
 * `as any` casts and `any[]` are also caught.
 *
 * Why a static list and not the whole repo: the goal is to ratchet — files
 * we already cleaned must stay clean. Other `any`s in the codebase are out
 * of scope until someone owns them.
 *
 * A path in the list that no longer exists is a FAILURE, not a skip. It used
 * to warn on stderr and still exit 0, so renaming or deleting a ratcheted file
 * quietly removed it from the gate: CI stayed green, the warning was folded
 * away in the log, and the file could grow `any`s again with nothing watching.
 * The list is hand-maintained, so the only way it stays true is to make the
 * build stop when it goes stale.
 *
 * Run: `bun run scripts/check-any.ts`
 *      `bun run scripts/check-any.ts path/to/extra/file.ts`  (override list)
 *
 * Allow-list: comments may contain the word `any` freely. Line comments and
 * block comments alike are ignored. To deliberately keep an `any` in code,
 * suffix the line with `// allow-any: <reason>`.
 *
 * (This sentence used to spell the block-comment delimiters out, with a
 * zero-width space wedged into the closing one so it would not end this very
 * comment. eslint's no-irregular-whitespace calls that an error, and nothing
 * caught it: CI lints from `client/`, so `scripts/` is outside every gate.)
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Files I authored end-to-end in slices 2/4/7 — they must stay zero-any
// forever. Pre-existing files I only edited a few lines in are intentionally
// excluded; cleaning their pre-existing `any`s is an orthogonal sweep.
const TRACKED_FILES = [
  // Slice 2 — ProviderSnapshotManager
  "server/providers/snapshot-manager.ts",

  // Slice 4 — snapshot hook + picker rewrite
  "client/src/hooks/useProvidersSnapshot.ts",
  "client/src/components/Chat/ProviderModelPicker.tsx",

  // Slice 7 — tool-call UI rewrite (new files)
  "client/src/components/Chat/ToolCallRow.tsx",
  "client/src/components/Chat/ReasoningRow.tsx",
  "client/src/components/Chat/MessageMetaFooter.tsx",
];

const ANY_RE = /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Thrown when the scan cannot cover the whole file. See `stripBlockComments`. */
class UnscannableFile extends Error {}

function stripBlockComments(src: string): string {
  // Coarse: replaces /* ... */ blocks with spaces so line numbers are preserved.
  // It is not a lexer, so a `/*` inside a string literal reads as a comment.
  //
  // That is why an unterminated block is a HARD FAILURE and not a `break`.
  // `break` returned everything before the `/*` and the caller scanned that
  // truncated text as if it were the file: one `const s = "/*"` anywhere and
  // the rest of the file left the ratchet, silently, while the summary line
  // still counted it as scanned. Exactly the class of bug that the missing-path
  // check below was written for. Loud and wrong beats quiet and wrong: the
  // reader gets a line number and two possible causes.
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) {
        const line = src.slice(0, i).split(/\r?\n/).length;
        throw new UnscannableFile(
          `unterminated /* opened at line ${line}: everything after it would go unscanned. ` +
            `Either the block comment is genuinely unclosed, or a string literal contains "/*" ` +
            `and this scanner is not a lexer. Close the comment, or split the literal.`,
        );
      }
      const block = src.slice(i, close + 2);
      out += block.replace(/[^\n]/g, " ");
      i = close + 2;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/** `null` means the path is gone — the caller turns that into a failure. */
function scan(file: string): Hit[] | null {
  const abs = resolve(file);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs, "utf-8");
  const cleaned = stripBlockComments(raw);
  const hits: Hit[] = [];
  cleaned.split(/\r?\n/).forEach((line, idx) => {
    const codePart = line.split("//")[0]; // strip line comments
    if (!ANY_RE.test(codePart)) return;
    if (line.includes("allow-any:")) return;
    hits.push({ file, line: idx + 1, text: line.trimEnd() });
  });
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  const overridden = argv.length > 0;
  const files = overridden ? argv : TRACKED_FILES;
  const hits: Hit[] = [];
  const missing: string[] = [];
  const unscannable: string[] = [];
  let scanned = 0;

  for (const f of files) {
    let found: Hit[] | null;
    try {
      found = scan(f);
    } catch (err) {
      if (!(err instanceof UnscannableFile)) throw err;
      unscannable.push(`${f}: ${err.message}`);
      continue;
    }
    if (found === null) {
      missing.push(f);
      continue;
    }
    scanned++;
    hits.push(...found);
  }

  // Before everything else: a file the scanner could not read to the end is a
  // hole in the ratchet, and reporting `any` hits from the part it did read
  // would suggest the rest was clean.
  if (unscannable.length > 0) {
    console.error(`[check-any] FAIL — ${unscannable.length} file(s) could not be scanned in full:`);
    for (const u of unscannable) console.error(`  ${u}`);
    process.exit(1);
  }

  // Reported before the `any` hits: a stale list makes the count below a lie,
  // so there is nothing useful to say about coverage until it is fixed.
  if (missing.length > 0) {
    console.error(`[check-any] FAIL — ${missing.length} of ${files.length} listed file(s) do not exist:`);
    for (const m of missing) console.error(`  ${m}`);
    console.error(
      overridden
        ? `\nThese paths came from the command line. Check them.`
        : `\nA renamed or deleted file drops out of the ratchet without a trace, so this is a failure and not a skip. Update TRACKED_FILES in scripts/check-any.ts: point the entry at the new path, or delete it if the file is gone for good.`,
    );
    process.exit(1);
  }

  if (hits.length === 0) {
    console.log(`[check-any] OK — ${scanned} file(s) scanned, all clean.`);
    process.exit(0);
  }

  console.error(`[check-any] FAIL — ${hits.length} occurrence(s) of 'any' in ${scanned} scanned file(s):`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${h.text}`);
  }
  console.error(`\nFix these or add a trailing '// allow-any: <reason>' comment.`);
  process.exit(1);
}

main();
