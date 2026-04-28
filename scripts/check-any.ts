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
 * Run: `bun run scripts/check-any.ts`
 *      `bun run scripts/check-any.ts path/to/extra/file.ts`  (override list)
 *
 * Allow-list: comments may contain the word `any` freely. Lines starting
 * with `//` or inside `/* … *​/` are ignored. To deliberately keep an `any`
 * in code, suffix the line with `// allow-any: <reason>`.
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
  "client/src/components/Chat/toolIcon.ts",
];

const ANY_RE = /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function stripBlockComments(src: string): string {
  // Coarse — replaces /* ... */ blocks with newlines so line numbers are
  // preserved. We don't care about exotic edge cases here.
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) break;
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

function scan(file: string): Hit[] {
  const abs = resolve(file);
  if (!existsSync(abs)) {
    console.warn(`[check-any] missing: ${file} (skipped)`);
    return [];
  }
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
  const files = argv.length > 0 ? argv : TRACKED_FILES;
  const hits: Hit[] = [];
  for (const f of files) hits.push(...scan(f));

  if (hits.length === 0) {
    console.log(`[check-any] OK — ${files.length} file(s) clean.`);
    process.exit(0);
  }

  console.error(`[check-any] FAIL — ${hits.length} occurrence(s) of 'any' in tracked files:`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${h.text}`);
  }
  console.error(`\nFix these or add a trailing '// allow-any: <reason>' comment.`);
  process.exit(1);
}

main();
