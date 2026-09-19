#!/usr/bin/env bun
/**
 * scripts/e2e-failed-titles.ts - the names of the red tests, from one or more
 * Playwright `results.json`.
 *
 * WHY IT EXISTS. The nightly's reporting worked and nobody read it: issue #31
 * stayed open from 01/09 collecting EIGHTEEN identical comments, one per night,
 * each saying "open the run and look at the per-shard jobs". Eighteen
 * invitations to redo the same investigation, and not one of them naming the
 * test that fell - always the same one, and it took a hand census on 19/09 to
 * find out.
 *
 * A warning that does not say what is broken makes its reader redo the
 * diagnosis every time, which is exactly how it stops being read.
 *
 * WHAT IT PRINTS: one line per failed test, `file:line > title`, sorted and
 * deduplicated (the same test can fall on several shards), with a ceiling
 * because a forty-line list inside an issue is noise again.
 *
 *   bun run scripts/e2e-failed-titles.ts <dir-or-file...>
 *
 * ALWAYS exits 0: it informs, it does not judge. Red or green is decided by the
 * job that ran the tests, and a failure here must not stop the reporting.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LINES = 40;

/** Every `results.json` under the given paths, at any depth. */
function findFiles(paths: string[]): string[] {
  const out: string[] = [];
  const visit = (p: string, depth = 0): void => {
    if (depth > 6) return; // an artifact tree is never this deep
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) {
      if (p.endsWith(".json")) out.push(p);
      return;
    }
    if (!st.isDirectory()) return;
    let entries: string[] = [];
    try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) visit(join(p, e), depth + 1);
  };
  for (const p of paths) visit(p);
  return out;
}

interface Spec {
  title?: string;
  file?: string;
  line?: number;
  ok?: boolean;
  tests?: Array<{ status?: string; results?: Array<{ status?: string }> }>;
}
interface Suite {
  title?: string;
  file?: string;
  specs?: Spec[];
  suites?: Suite[];
}

/**
 * A test counts as red when its FINAL status is neither passed nor skipped.
 * The entry's `status` is what is read, not the individual attempt: a test that
 * went green on the second try is NOT a red, and listing it would send
 * somebody hunting a defect that is not there.
 */
function collect(suite: Suite, out: Set<string>): void {
  for (const spec of suite.specs ?? []) {
    const red = (spec.tests ?? []).some((t) => {
      const st = t.status ?? "";
      // `flaky` is NOT a red: it means the retry passed. The first version of
      // this line counted it, and the test rejected that version - which is the
      // worst case for a warning, because it sends somebody hunting a defect
      // that is not there and teaches them to distrust the list.
      return st !== "expected" && st !== "skipped" && st !== "flaky";
    });
    if (!red) continue;
    const file = spec.file ?? suite.file ?? "?";
    const line = spec.line ? `:${spec.line}` : "";
    out.add(`${file}${line} > ${spec.title ?? "(untitled)"}`);
  }
  for (const s of suite.suites ?? []) collect(s, out);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("(no path given)");
  process.exit(0);
}

const found = new Set<string>();
let read = 0;
for (const f of findFiles(args)) {
  try {
    const data = JSON.parse(readFileSync(f, "utf8")) as { suites?: Suite[] };
    for (const s of data.suites ?? []) collect(s, found);
    read++;
  } catch {
    /* a truncated artifact must not silence the others */
  }
}

if (read === 0) {
  console.log("(no readable results.json)");
  process.exit(0);
}
if (found.size === 0) {
  // This happens for real: a shard that dies mid-run writes no outcomes, and
  // the job fails without any TEST being red. Saying so is information, not a
  // hole: it sends the reader after a crash instead of an assertion.
  console.log("(no red test in the outcomes: did the shard die before writing them?)");
  process.exit(0);
}

const lines = [...found].sort();
for (const r of lines.slice(0, MAX_LINES)) console.log(r);
if (lines.length > MAX_LINES) console.log(`... and ${lines.length - MAX_LINES} more`);
