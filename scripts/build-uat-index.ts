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
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
/**
 * The artifact folders: `test-results/artifacts` plus the `artifacts-<port>` ones the
 * sharder creates, one per shard (see `outputDir` in playwright.config.ts). Reading only
 * one of them would drop from the index everything the other shards produced.
 */
function artifactRoots(): string[] {
  const base = join(ROOT, "test-results");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => d === "artifacts" || d.startsWith("artifacts-"))
    .map((d) => join(base, d))
    .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .sort();
}
const VIDEOS_DIR = join(ROOT, "videos");
const INDEX = join(VIDEOS_DIR, "INDEX.md");

interface Entry {
  /** Which artifact folder it comes from: there is one per shard. */
  root: string;
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

/**
 * `--only-requirements`: do NOT link one piece of evidence per artifact folder.
 *
 * The why is a number. The full run of 25/08 produced 1201 videos and `publish-uat`
 * uploaded every one of them — 85 MB — but the living-doc can only open the ones tied to
 * a requirement, which were 121. Eleven hundred uploaded files nobody can reach are not
 * prudence, they are bandwidth and space spent for nothing, and they make every publish
 * slow in proportion to what is NOT seen.
 *
 * The default is unchanged: `uat.html` locally lives off that pass.
 */
const ONLY_REQUIREMENTS = process.argv.includes("--only-requirements");

function collect(): Entry[] {
  if (ONLY_REQUIREMENTS) return [];
  const roots = artifactRoots();
  if (roots.length === 0) return [];
  const iReport = process.argv.indexOf("--report");
  const report = iReport >= 0 ? process.argv[iReport + 1] : null;
  const outcomes = report && existsSync(report) ? outcomesFromReport(report) : new Map();

  const entries: Entry[] = [];
  for (const root of roots) for (const folder of readdirSync(root)) {
    const dir = join(root, folder);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".webm")) continue;
      const fromReport = outcomes.get(folder);
      entries.push({
        root,
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
  if (ONLY_REQUIREMENTS) {
    // No per-folder index and no INDEX.md: only what a requirement can open gets
    // linked here, and that is `linkByRequirement`'s job.
    if (!process.argv.includes("--by-requirement")) {
      console.error("[uat-index] --only-requirements senza --by-requirement non collega niente.");
      process.exit(1);
    }
    linkByRequirement();
    // The per-file sessions live in the same round: the chain always passes `--only-requirements`,
    // and without this line `--by-file` would never run in production.
    if (process.argv.includes("--by-file")) linkByFile();
    return;
  }
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
    const src = join(v.root, v.folder, `${v.file}.webm`);
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

  // `--by-requirement`: a SECOND link of the same video, under
  // `videos/<capability>/<REQ-ID>.webm`. That is the layout the platform serves and the one the
  // OpenSpec reader looks in, and the name is the requirement id — exact, not a similarity match
  // on the test title, which is how a scenario ends up showing somebody else's recording.
  // Hard links, so the second name costs no bytes.
  if (process.argv.includes("--by-requirement")) linkByRequirement();
  if (process.argv.includes("--by-file")) linkByFile();

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


/** Requirement id -> capability, read from the OpenSpec tree. The id alone does not say where it lives. */
function capabilityById(): Map<string, string> {
  const out = new Map<string, string>();
  const specs = join(ROOT, "openspec/specs");
  if (!existsSync(specs)) return out;
  for (const cap of readdirSync(specs)) {
    const dir = join(specs, cap);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/^###\s+Requirement:\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[a-z]?)\b/gm)) {
        out.set(m[1]!, cap);
      }
    }
  }
  return out;
}

/**
 * Links every video whose test declared a `spec` annotation to `videos/<capability>/<REQ-ID>.webm`,
 * and its trace to the matching `.zip`. Silent about requirements with no video: most of them are
 * covered by unit tests, which never record one, and saying so once per line would bury the rest.
 */
function linkByRequirement(): void {
  const iReport = process.argv.indexOf("--report");
  const report = iReport >= 0 ? process.argv[iReport + 1] : null;
  if (!report || !existsSync(report)) {
    console.error("[uat-index] --by-requirement senza --report: gli esiti e le annotazioni stanno la' dentro, non nei nomi delle cartelle.");
    process.exit(1);
  }
  const capOf = capabilityById();
  let linked = 0, orphan = 0;
  for (const { specIds, video, trace, poster } of specAttachments(report)) {
    for (const id of specIds) {
      const cap = capOf.get(id);
      if (!cap) { orphan++; continue; }
      const destDir = join(VIDEOS_DIR, cap);
      mkdirSync(destDir, { recursive: true });
      for (const [src, ext] of [[video, ".webm"], [trace, ".zip"], [poster, ".png"]] as const) {
        if (!src || !existsSync(src)) continue;
        const dest = join(destDir, id + ext);
        if (existsSync(dest)) continue;
        try { linkSync(src, dest); } catch { try { copyFileSync(src, dest); } catch { continue; } }
        if (ext === ".webm") linked++;
      }
    }
  }
  console.log(`[uat-index] per requisito: ${linked} video collegati sotto videos/<capability>/<REQ-ID>.webm` +
    (orphan ? `, ${orphan} annotazioni verso requisiti che non esistono` : ""));
}

/**
 * `--by-file`: the sessions of the FILES that declare a requirement without proving it per-test.
 *
 * A requirement declared with `@covers` by an e2e file cannot have a session of its OWN — the
 * link runs through the annotation, and the file holds many of them. Showing a random one would
 * be passing off as evidence a recording that may have nothing to do with it. What can be done
 * honestly is to change the promise: not "here is the proof", but "the file that declares it has
 * these N sessions". Material to watch, not a verdict — and that is why they sit in a separate
 * channel (`fileSessions`) and not in `traceUrl`.
 *
 * ONLY the files declaring at least one requirement with no per-test evidence are linked: the
 * others already have their session, and duplicating it would cost weight and add nothing.
 * Measured 2026-08-26: 70 files, 278 sessions, ~41 MB.
 */
function linkByFile(): void {
  const iReport = process.argv.indexOf("--report");
  const report = iReport >= 0 ? process.argv[iReport + 1] : null;
  const iMap = process.argv.indexOf("--coverage-map");
  const mapPath = iMap >= 0 ? process.argv[iMap + 1] : "openspec/coverage-map.json";
  if (!report || !existsSync(report) || !existsSync(join(ROOT, mapPath))) {
    console.error("[uat-index] --by-file richiede --report <json> e una coverage map leggibile.");
    process.exit(1);
  }
  type Claim = { file?: string; channel?: string };
  const coverageMap = JSON.parse(readFileSync(join(ROOT, mapPath), "utf8")) as {
    requirements?: Record<string, { claims?: Claim[] }>;
  };
  // Which requirements already have per-test evidence? Those are not needed.
  const withEvidence = new Set<string>();
  for (const { specIds } of specAttachments(report)) for (const id of specIds) withEvidence.add(id);
  const filesToCover = new Set<string>();
  for (const [id, rec] of Object.entries(coverageMap.requirements ?? {})) {
    if (withEvidence.has(id)) continue;
    for (const c of rec.claims ?? []) {
      if (c.file && c.file.includes("/e2e/")) filesToCover.add(c.file.split("/").pop()!);
    }
  }

  // `spec.file` in the report is relative to `config.rootDir` (the testDir), while the map's
  // claims are relative to the repo root. The manifest has to speak the claims' language, or the
  // toolkit will NEVER find a match — and it will fail silently, with 278 sessions published and
  // zero linked. It happened on 2026-08-26: the same stumble already avoided in
  // readPlaywrightOutcomes.
  let prefix = "";
  try {
    const configRoot = (JSON.parse(readFileSync(report, "utf8")) as { config?: { rootDir?: string } }).config?.rootDir;
    if (configRoot) prefix = relative(ROOT, configRoot).replaceAll("\\", "/");
  } catch { /* no prefix: the keys stay the report's own */ }

  const destDir = join(VIDEOS_DIR, "_sessioni");
  mkdirSync(destDir, { recursive: true });
  const manifest: Record<string, Array<{ titolo: string; slug: string; esito: string }>> = {};
  let linked = 0;
  for (const { file, titolo, esito, trace } of allSpecs(report)) {
    if (!filesToCover.has(file) || !trace || !existsSync(trace)) continue;
    const base = file.replace(/\.spec\.ts$/, "");
    const n = (manifest[prefix ? `${prefix}/${file}` : file] ?? []).length;
    const slug = `${base}__${n}`;
    const dest = join(destDir, slug + ".zip");
    if (!existsSync(dest)) {
      try { linkSync(trace, dest); } catch { try { copyFileSync(trace, dest); } catch { continue; } }
    }
    (manifest[prefix ? `${prefix}/${file}` : file] ??= []).push({ titolo, slug, esito });
    linked++;
  }
  writeFileSync(join(destDir, "INDEX.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`[uat-index] per file: ${linked} sessioni collegate sotto videos/_sessioni/, da ${Object.keys(manifest).length} file su ${filesToCover.size} da coprire`);
}

/** Every spec of the report: file, title, outcome and trace — annotated or not. */
function allSpecs(report: string): Array<{ file: string; titolo: string; esito: string; trace: string | null }> {
  const out: Array<{ file: string; titolo: string; esito: string; trace: string | null }> = [];
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(report, "utf8")); } catch { return out; }
  const visit = (suite: Record<string, unknown>): void => {
    for (const spec of (suite.specs as Record<string, unknown>[] | undefined) ?? []) {
      const file = typeof spec.file === "string" ? spec.file : "";
      for (const test of (spec.tests as Record<string, unknown>[] | undefined) ?? []) {
        const results = (test.results as Record<string, unknown>[] | undefined) ?? [];
        const r = results[results.length - 1];
        const attachments = (r?.attachments as Record<string, unknown>[] | undefined) ?? [];
        const a = attachments.find((x) => x.name === "trace" && typeof x.path === "string");
        out.push({
          file,
          titolo: typeof spec.title === "string" ? spec.title : "",
          esito: typeof test.status === "string" ? (test.status as string) : "unknown",
          trace: a ? (a.path as string) : null,
        });
      }
    }
    for (const s of (suite.suites as Record<string, unknown>[] | undefined) ?? []) visit(s);
  };
  for (const s of ((doc as Record<string, unknown>)?.suites as Record<string, unknown>[] | undefined) ?? []) visit(s);
  return out;
}

/** Per spec of the report: the requirement ids it declares, plus its video and trace paths. */
function specAttachments(report: string): Array<{ specIds: string[]; video: string | null; trace: string | null; poster: string | null }> {
  const out: Array<{ specIds: string[]; video: string | null; trace: string | null; poster: string | null }> = [];
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(report, "utf8")); } catch { return out; }
  const visit = (suite: Record<string, unknown>): void => {
    for (const spec of (suite.specs as Record<string, unknown>[] | undefined) ?? []) {
      for (const test of (spec.tests as Record<string, unknown>[] | undefined) ?? []) {
        const results = (test.results as Record<string, unknown>[] | undefined) ?? [];
        const r = results[results.length - 1];
        const anns = ((test.annotations as Record<string, unknown>[] | undefined)?.length
          ? (test.annotations as Record<string, unknown>[])
          : ((r?.annotations as Record<string, unknown>[] | undefined) ?? []));
        const specIds = anns
          .filter((a) => a.type === "spec" && typeof a.description === "string")
          .flatMap((a) => String(a.description).split(/[,\s/]+/))
          .filter((x) => /^[A-Z][A-Z0-9-]*-\d+[a-z]?$/.test(x));
        if (specIds.length === 0) continue;
        const attachments = (r?.attachments as Record<string, unknown>[] | undefined) ?? [];
        const pathOf = (n: string) => {
          const a = attachments.find((x) => x.name === n && typeof x.path === "string");
          return a ? (a.path as string) : null;
        };
        out.push({ specIds: [...new Set(specIds)], video: pathOf("video"), trace: pathOf("trace"), poster: pathOf("screenshot") });
      }
    }
    for (const s of (suite.suites as Record<string, unknown>[] | undefined) ?? []) visit(s);
  };
  for (const s of ((doc as Record<string, unknown>)?.suites as Record<string, unknown>[] | undefined) ?? []) visit(s);
  return out;
}

if (import.meta.main) main();

export { titleFromFolder, outcomesFromReport };
