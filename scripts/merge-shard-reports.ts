#!/usr/bin/env bun
/**
 * Merges the per-shard Playwright JSON reports into one.
 *
 * `e2e-shards.sh` writes `report-<i>.json` per shard; every reader downstream — spec-flow's
 * living-doc, `build-uat-index` — opens exactly ONE report. Without this step the page shows the
 * outcomes of whichever shard happened to be read and calls the rest "never run", which looks
 * identical to a suite that was never launched.
 *
 * The merge is a concatenation of top-level suites, which is safe because the shard planner gives
 * each shard a DISJOINT set of FILES. That is asserted, not assumed: the same spec turning up in
 * two shards means the plan overlapped, and every count downstream is inflated by that much.
 *
 * The identity of a spec is its Playwright `id`, NOT file:line:title. This config has five
 * projects (chromium, chromium-touch, chromium-phone, chromium-touch-wide, webkit), so one test
 * legitimately appears once PER PROJECT at the very same file, line and column — and a key that
 * ignores the project calls that an overlap. Measured on the first real run: 7 false alarms,
 * all of them chromium/webkit pairs of the same test.
 *
 * Usage:  bun run scripts/merge-shard-reports.ts [dir] --out test-results/uat-report.json
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

type Spec = { id?: string; title: string; file?: string; line?: number; column?: number };
type Suite = { specs?: Spec[]; suites?: Suite[] };
type Report = { suites?: Suite[]; stats?: Record<string, number>; errors?: unknown[] } & Record<string, unknown>;

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const OUT = outFlag >= 0 ? args[outFlag + 1]! : "test-results/uat-report.json";
const DIR = args.find((a, i) => !a.startsWith("--") && (outFlag < 0 || i !== outFlag + 1))
  ?? join(process.env.TMPDIR ?? "/tmp", "topics-e2e-shards");

if (!existsSync(DIR)) {
  console.error(`merge-shard-reports: ${DIR} non esiste — nessun report da fondere.`);
  process.exit(1);
}
const files = readdirSync(DIR).filter((f) => /^report-\d+\.json$/.test(f)).sort();
if (files.length === 0) {
  console.error(`merge-shard-reports: nessun report-N.json in ${DIR}. Uno shard morto non lascia il file: guarda gli shard-N.log.`);
  process.exit(1);
}

function collect(s: Suite, out: Spec[] = []): Spec[] {
  for (const sp of s.specs ?? []) out.push(sp);
  for (const c of s.suites ?? []) collect(c, out);
  return out;
}

const merged: Report = { config: undefined, suites: [], errors: [], stats: {} };
const seen = new Map<string, string>();
let duplicates = 0;
const overlapping = new Set<string>();
const perShard: string[] = [];

for (const f of files) {
  let rep: Report;
  try {
    rep = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Report;
  } catch (e) {
    console.error(`merge-shard-reports: ${f} illeggibile (${(e as Error).message}). Uno shard e' morto scrivendo: NON si fonde un report parziale in silenzio.`);
    process.exit(1);
  }
  // The first shard's `config` wins: they are the same run, same config, different file lists.
  if (!merged.config) merged.config = rep.config;
  const specs = (rep.suites ?? []).flatMap((s) => collect(s));
  for (const sp of specs) {
    // `id` carries the project; the positional fallback deliberately does not, so on a report
    // without ids a same-shard project pair is counted once rather than flagged as an overlap.
    const key = sp.id ?? `${sp.file ?? "?"}:${sp.line ?? 0}:${sp.column ?? 0}:${sp.title}`;
    const from = seen.get(key);
    if (from === undefined) seen.set(key, f);
    else if (from !== f) { duplicates++; overlapping.add(`${sp.file ?? "?"} › ${sp.title}`); }
  }
  merged.suites!.push(...(rep.suites ?? []));
  merged.errors = [...(merged.errors as unknown[]), ...((rep.errors as unknown[]) ?? [])];
  for (const [k, v] of Object.entries(rep.stats ?? {})) {
    if (typeof v === "number") merged.stats![k] = (merged.stats![k] ?? 0) + v;
  }
  perShard.push(`${f}: ${specs.length} spec`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(merged));

for (const line of perShard) console.log(`  ${line}`);
console.log(`merge-shard-reports -> ${OUT}: ${files.length} shard, ${seen.size} spec distinte.`);
if (duplicates > 0) {
  // Not a detail: two SHARDS having run the same test means the plan overlapped, and every count
  // downstream is inflated by exactly that much.
  console.error(`merge-shard-reports: ${duplicates} spec eseguite da PIU' shard — il piano si e' sovrapposto, i conteggi non sono affidabili.`);
  for (const d of [...overlapping].slice(0, 10)) console.error(`  - ${d}`);
  process.exit(1);
}
