#!/usr/bin/env bun
/**
 * `videos/INDEX.md`, built from the videos the E2E suite ALREADY produces.
 *
 * THE MISSING BRIDGE. spec-flow already knows how to build `uat.html` — a page
 * a client opens and watches, with every video and its outcome in it. What it
 * wants as input is not Gherkin: it is a `videos/INDEX.md` of lines
 *
 *     - ✅ [readable title](./folder/file.webm) — 1234ms
 *
 * plus the `.webm` files. Topics produces 222 of those on every pass with
 * `E2E_EVIDENCE=1`, so the only missing piece was this list. Which means the
 * question "can the E2E suite go on spec-flow?" has an answer: yes, and without
 * rewriting a single test.
 *
 * WHY NO `.feature` IS NEEDED. `generate-uat` reads the Given/When/Then from
 * `openspec/specs/<feature>.md` as a FALLBACK for technical detail, not as the
 * source of the videos: without one, the card shows the test title and its
 * outcome, which is exactly what watching them requires. `.feature` files stay
 * useful for flows somebody wants told in words, not for seeing the evidence.
 *
 * WHERE THE OUTCOME COMES FROM. From Playwright's JSON report when there is one
 * (`--reporter=json`); otherwise from the mere presence of the video —
 * `retain-on-failure` keeps only the reds, `E2E_EVIDENCE=1` keeps everything.
 * With no report a video is therefore `⚠️` and NOT `✅`, because saying "passed"
 * without knowing is how a page of evidence stops being worth anything.
 *
 * WHERE THE VIDEOS GO. Into `videos/<folder>/video.webm`, which is what
 * `spec-flow.config.json` declares (`videosDir: "videos"`) and what
 * `.gitignore` already expects. Playwright writes them under
 * `test-results/artifacts/`, and this script LINKS them (hard link, zero extra
 * bytes; a copy when the link is impossible). Bending the config to the files
 * instead would have been quicker and would have broken the convention the repo
 * already gave itself.
 *
 * Usage:
 *   bun run scripts/build-uat-index.ts                 # from videos on disk
 *   bun run scripts/build-uat-index.ts --report r.json # with real outcomes
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ARTIFACTS = join(ROOT, "test-results", "artifacts");
const VIDEOS_DIR = join(ROOT, "videos");
const INDEX = join(VIDEOS_DIR, "INDEX.md");

interface Entry {
  /** The artifact folder, which Playwright names after the test title. */
  folder: string;
  /** The file name without `.webm`. */
  file: string;
  title: string;
  outcome: "pass" | "fail" | "unknown";
  durationMs: number | null;
}

/**
 * The readable title, recovered from the artifact folder.
 *
 * Playwright names it `<spec>-<truncated describe>-<hash>-<truncated test>-chromium`:
 * the title IS in there, but shredded. It is not reconstructed by guessing —
 * the project suffix and the hash come off, and what is left stays readable.
 * With the JSON report the REAL title comes from there and this is not used.
 */
function titleFromFolder(name: string): string {
  return name
    .replace(/-chromium(-retry\d+)?$/, "")
    .replace(/-[0-9a-f]{5}-/, " · ")
    .replace(/-/g, " ")
    .trim();
}

/** The real outcomes, when a Playwright JSON report exists. */
function outcomesFromReport(path: string): Map<string, { title: string; outcome: Entry["outcome"]; durationMs: number | null }> {
  const out = new Map<string, { title: string; outcome: Entry["outcome"]; durationMs: number | null }>();
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return out;
  }
  const visit = (suite: Record<string, unknown>, path: string[]): void => {
    const title = typeof suite.title === "string" ? suite.title : "";
    const here = title ? [...path, title] : path;
    for (const spec of (suite.specs as Record<string, unknown>[] | undefined) ?? []) {
      const name = typeof spec.title === "string" ? spec.title : "";
      for (const test of (spec.tests as Record<string, unknown>[] | undefined) ?? []) {
        for (const r of (test.results as Record<string, unknown>[] | undefined) ?? []) {
          const state = r.status === "passed" ? "pass" : r.status === "failed" || r.status === "timedOut" ? "fail" : "unknown";
          const duration = typeof r.duration === "number" ? Math.round(r.duration) : null;
          for (const a of (r.attachments as Record<string, unknown>[] | undefined) ?? []) {
            if (a.name !== "video" || typeof a.path !== "string") continue;
            const folder = a.path.split("/").slice(-2)[0] ?? "";
            if (folder) out.set(folder, { title: [...here, name].filter(Boolean).join(" › "), outcome: state, durationMs: duration });
          }
        }
      }
    }
    for (const s of (suite.suites as Record<string, unknown>[] | undefined) ?? []) visit(s, here);
  };
  for (const s of ((doc as Record<string, unknown>)?.suites as Record<string, unknown>[] | undefined) ?? []) visit(s, []);
  return out;
}

function collect(): Entry[] {
  if (!existsSync(ARTIFACTS)) return [];
  const iReport = process.argv.indexOf("--report");
  const report = iReport >= 0 ? process.argv[iReport + 1] : null;
  const outcomes = report && existsSync(report) ? outcomesFromReport(report) : new Map();

  const entries: Entry[] = [];
  for (const folder of readdirSync(ARTIFACTS)) {
    const dir = join(ARTIFACTS, folder);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".webm")) continue;
      const fromReport = outcomes.get(folder);
      entries.push({
        folder,
        file: f.replace(/\.webm$/, ""),
        title: fromReport?.title || titleFromFolder(folder),
        // With no report a green is NOT declared: the video alone does not prove it.
        outcome: outcomeOf(fromReport?.outcome),
        durationMs: fromReport?.durationMs ?? null,
      });
    }
  }
  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

const GLYPH: Record<Entry["outcome"], string> = { pass: "✅", fail: "❌", unknown: "⚠️" };

/**
 * The outcome of a video — and this is the rule the file exists to hold.
 *
 * With no line in a report, that video is NOT green. A `.webm` proves a
 * recording happened, not that the test passed — and `retain-on-failure` (the
 * suite default) keeps the videos of exactly the REDS. Declaring those passed
 * would make the evidence page worse than not having one.
 *
 * It is exposed instead of being buried in a `??` so that it can be tested:
 * remove it and the test goes red.
 */
export function outcomeOf(fromReport: Entry["outcome"] | undefined): Entry["outcome"] {
  return fromReport ?? "unknown";
}

function main(): void {
  const entries = collect();
  if (entries.length === 0) {
    console.error(
      "[uat-index] nessun video sotto test-results/artifacts/.\n" +
      "Producili con: E2E_EVIDENCE=1 npx playwright test --project=chromium",
    );
    process.exit(1);
  }
  mkdirSync(VIDEOS_DIR, { recursive: true });

  // The videos under `videos/`, where the config looks for them. Hard links:
  // they are tens of MB and copying them every run would fill the disk for
  // nothing.
  for (const v of entries) {
    const src = join(ARTIFACTS, v.folder, `${v.file}.webm`);
    const destDir = join(VIDEOS_DIR, v.folder);
    const dest = join(destDir, `${v.file}.webm`);
    if (existsSync(dest)) continue;
    mkdirSync(destDir, { recursive: true });
    try {
      linkSync(src, dest);
    } catch {
      // Different volumes, or a filesystem with no hard links: copy is the fallback.
      try { copyFileSync(src, dest); } catch { /* the video is missing: the line stays, the player will say so */ }
    }
  }

  const lines = [
    "# Video delle prove E2E",
    "",
    "Generato da `scripts/build-uat-index.ts`. Ogni riga e' un test della suite",
    "Playwright con il suo video; `spec-flow` legge questo file per costruire",
    "`uat.html`, la pagina che si guarda.",
    "",
    "Un `⚠️` significa che il video c'e' ma l'esito non e' stato letto da un report:",
    "passare `--report <playwright.json>` per averli veri.",
    "",
  ];
  for (const v of entries) {
    const duration = v.durationMs != null ? ` — ${v.durationMs}ms` : "";
    lines.push(`- ${GLYPH[v.outcome]} [${v.title}](./${v.folder}/${v.file}.webm)${duration}`);
  }
  writeFileSync(INDEX, lines.join("\n") + "\n");

  const countOf = (e: Entry["outcome"]) => entries.filter((v) => v.outcome === e).length;
  console.log(
    `[uat-index] ${INDEX}: ${entries.length} video ` +
    `(${countOf("pass")} passati, ${countOf("fail")} falliti, ${countOf("unknown")} senza esito noto)`,
  );
}

if (import.meta.main) main();

export { titleFromFolder, outcomesFromReport };
