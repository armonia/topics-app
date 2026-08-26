#!/usr/bin/env bun
/**
 * SPEC ↔ TEST TRACEABILITY: a requirement no test claims, and a test that
 * claims a requirement which does not exist.
 *
 * WHY IT EXISTS. "the tests cover everything" cannot be checked until there is
 * a denominator. Here the denominator is the set of requirements declared in
 * `openspec/specs/`, and the link is a line the test writes about itself.
 *
 * THE DEFECT THAT PRODUCED THIS FILE, measured 2026-08-25: requirement ids and
 * test scenario ids share the SAME syntax (`CAP-nn`) but are two independent
 * counters, and nothing kept them apart. Result: 24 ids that mean two things.
 * For the spec `CMD-02` is "Push Notifications", for `command-palette.spec.ts`
 * it is "topic search filters and navigates"; `CMD-03` is "Reopen most recently
 * closed tab" for one and "theme toggle" for the other; `TERM-02` is "Reload a
 * Terminal Session In Place" and "terminal accepts keyboard input". Someone
 * reading "CMD-03 green" cannot tell what was proven, and the real requirement
 * may have no test at all — which is what this gate now says out loud.
 *
 * THE THREE INVARIANTS.
 *
 *   R1 DANGLING — a test claims a requirement the specs do not have. This is
 *      not (only) a typo'd id: 54 measured, including whole families such as
 *      `GUEST-01..04`, i.e. behaviour a test ALREADY proves that the document
 *      of record never declares. The cure differs case by case: fix the id, or
 *      write the requirement.
 *
 *   R2 UNCOVERED — a requirement no test claims. Not blocking per se: what
 *      blocks is REGRESSION against the committed baseline. A new requirement
 *      with no test goes red; already-known debt does not, until it grows.
 *
 *   R4 NOT UNIQUE — the same scenario id naming two different tests. Always
 *      blocking, no baseline: it went to zero on 2026-08-25 and there is no
 *      honest reason for it to come back. `BROWSER-CHAT-04` named five tests in
 *      one file and `AC-1` named tests in three different files; an id that
 *      names five things names none, and a green "AC-1" said nothing about
 *      which of them passed.
 *
 *   R3 AMBIGUOUS — a requirement id used as a test-title prefix by a test that
 *      does NOT claim it. This is the collision described above. Baselined the
 *      same way, so the gate stops it from growing.
 *
 * THE BASELINE IS CONSUMED. `coverage-baseline.json` lists tolerated
 * violations, and an entry that is no longer violated FAILS the gate: the list
 * shrinks instead of sitting there covering debt already paid. That is the
 * difference between a baseline and a carpet.
 *
 * HOW A TEST DECLARES — two channels, one per runner.
 *
 *   Playwright (`.spec.ts`), per scenario, the convention ALREADY IN USE here:
 *     test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
 *
 *   bun test (`.test.ts`), in the file header comment, because `test.info()`
 *   does not exist there:
 *     @covers KANBAN-01, KANBAN-02
 *
 * The first was not invented for this gate: 274 tests in 45 files already used
 * it, and of those 99 ids only 35 resolved to a real requirement. A gate that
 * demanded a NEW tag would have forced the same thing to be declared twice and
 * left the existing convention to rot.
 *
 *   bun run scripts/check-spec-coverage.ts            # gate (exit 1 when red)
 *   bun run scripts/check-spec-coverage.ts --report   # snapshot only
 *   bun run scripts/check-spec-coverage.ts --write-baseline
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SPECS = join(ROOT, "openspec", "specs");
const BASELINE = join(ROOT, "openspec", "coverage-baseline.json");

/** Roots where a test can live. Outside these, a `@covers` is never seen. */
const TEST_ROOTS = ["tests", "client/src", "server", "shared", "relay", "cli", "scripts"];

type Requirement = {
  id: string;
  capability: string;
  title: string;
  file: string;
  /** The spec says out loud that this describes code nobody wrote. */
  notBuilt: boolean;
};
type FileTest = { path: string; covers: string[]; annotated: string[]; titles: { id: string; title: string }[] };

/** `spec` annotations that name no requirement at all: collected by R7 instead of discarded. */
const muteAnnotations: { file: string; desc: string }[] = [];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "data") continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    } catch {
      /* a broken link or a file that vanished mid-walk is not a gate failure */
    }
  }
  return out;
}

/**
 * A requirement that describes code NOBODY WROTE.
 *
 * Eight of them were measured on 2026-08-25 — agent roster, webhook CRUD,
 * activity feed, journal & digest, extended approvals, the withdrawn tunnel —
 * and they are a different animal from debt. A requirement with no test is a
 * test somebody owes. A requirement with no CODE is a document lying to
 * whoever reads it: the cure is deleting it, not testing it, and counting the
 * two together turns the gate's headline number into noise ("8 uncovered"
 * reads as eight holes when there are none).
 *
 * So the spec says it about itself, on a line under the heading:
 *
 *     **Status: NOT BUILT** — <why, and what would have to happen>
 *
 * It sits where the reader is, not in a baseline file they will never open.
 * And it has teeth in BOTH directions: a marked requirement is excluded from
 * the uncovered count, but if a test ever claims it, the gate fails and says
 * the marker is stale. That is the day someone built the thing — the note has
 * to go, and nobody has to remember to remove it.
 */
const NOT_BUILT_MARKER = /^\s*(?:>\s*)?\*\*Status:\s*NOT BUILT\*\*/m;

/**
 * Declared requirements: `### Requirement: CAP-nn — title`.
 *
 * A middle segment may contain digits (`RELAY-E2E-01`), and that is not
 * cosmetic: the claim side has always accepted such ids
 * (`/^[A-Z][A-Z0-9-]*-\d+[a-z]?$/`), so with `[A-Z]+` here the two sides read a
 * DIFFERENT vocabulary — a requirement written with that id was invisible to
 * this file, which made those nine claims permanently dangling with no way to
 * cure them except renaming the test. Measured 2026-08-25: widening this to
 * `[A-Z0-9]+` changes the parse of no heading that exists today, and the same
 * widening on the title regex below adds thirteen titles, none of them a
 * duplicate and none naming a requirement, so R3 and R4 stay where they were.
 */
function readRequirements(): Requirement[] {
  const out: Requirement[] = [];
  for (const f of walk(SPECS)) {
    if (!f.endsWith(".md")) continue;
    const capability = f.slice(SPECS.length + 1).split("/")[0]!;
    const text = readFileSync(f, "utf8");
    const heads = [...text.matchAll(/^###\s+Requirement:\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[a-z]?)\s*[—–-]*\s*(.*)$/gm)];
    for (let i = 0; i < heads.length; i++) {
      const m = heads[i]!;
      // The requirement's own body, up to the next `###`. Read only to spot
      // the NOT BUILT marker described below.
      const body = text.slice(m.index! + m[0].length, heads[i + 1]?.index ?? text.length);
      out.push({
        id: m[1]!,
        capability,
        title: (m[2] ?? "").trim(),
        file: f.slice(ROOT.length),
        notBuilt: NOT_BUILT_MARKER.test(body),
      });
    }
  }
  return out;
}

/** One test file: what it claims to cover, and the ids it names its scenarios with. */
function readTests(): FileTest[] {
  const out: FileTest[] = [];
  for (const root of TEST_ROOTS) {
    for (const f of walk(join(ROOT, root))) {
      if (!/\.(test|spec)\.(ts|tsx)$/.test(f)) continue;
      const text = readFileSync(f, "utf8");
      // TWO channels, because the two runners do not have the same tool.
      //
      //  - Playwright: `test.info().annotations.push({type:"spec", ...})`. This
      //    is the convention ALREADY IN USE here (274 tests, 45 files) and it
      //    lives on the single scenario. It was not invented for this gate: a
      //    gate that ignores the house convention forces the same fact to be
      //    declared twice.
      //  - bun test: `test.info()` does not exist, so for unit tests the link
      //    is a `@covers` in the header comment, at FILE granularity.
      // R7: a `spec` annotation carrying NO valid id declares nothing, and until now it
      // vanished in here without a word. A test that writes
      // `description: "FILE-EDITOR-ABORT"` believes it declared a requirement: it colours
      // nothing in the living-doc, it does not show up among the dangling ones (R1 only sees
      // what passes the filter), and it clears `check-untraced-tests`, which looked at the
      // SHAPE of the annotation alone. Nine cases across five files, measured 2026-08-26,
      // all invisible to both gates.
      const fromAnnotation: string[] = [];
      for (const m of text.matchAll(/type:\s*["']spec["']\s*,\s*description:\s*["'`]([^"'`]+)["'`]/g)) {
        const valid = m[1]!.split(/[,\s/]+/).filter((s: string) => /^[A-Z][A-Z0-9-]*-\d+[a-z]?$/.test(s));
        // A description may carry the id plus free text ("KANBAN-12 (flatten group)"): ONE
        // valid id is enough for the rest to be prose rather than a mistake.
        if (valid.length) fromAnnotation.push(...valid);
        else muteAnnotations.push({ file: f.slice(ROOT.length), desc: m[1]! });
      }
      const fromCovers = [...text.matchAll(/@covers\s+([A-Z0-9,\s-]+)/g)]
        .flatMap((m) => m[1]!.split(/[,\s]+/))
        .filter((s: string) => /^[A-Z][A-Z0-9-]*-\d+[a-z]?$/.test(s));
      const covers = [...new Set([...fromAnnotation, ...fromCovers])];
      const titles = [...text.matchAll(/\b(?:test|it)\(\s*["'`]([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[a-z]?)[^"'`]*?:\s*([^"'`]{0,90})/g)].map(
        (m) => ({ id: m[1]!, title: (m[2] ?? "").trim() }),
      );
      // `annotated` is the PER-TEST channel kept apart from the union: only it can carry an
      // outcome. A `@covers` names a FILE, and a file holds many tests, so it is evidence of
      // a link — never evidence that the requirement passed.
      const annotated = [...new Set(fromAnnotation)];
      if (covers.length || titles.length) out.push({ path: f.slice(ROOT.length), covers, annotated, titles });
    }
  }
  return out;
}

type Baseline = { scoperti: string[]; ambigui: string[]; penzolanti: string[]; motivi: Record<string, string>; motiviPenzolanti: Record<string, string> };

function readBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { scoperti: [], ambigui: [], penzolanti: [], motivi: {}, motiviPenzolanti: {} };
  const j = JSON.parse(readFileSync(BASELINE, "utf8")) as Partial<Baseline>;
  return { scoperti: j.scoperti ?? [], ambigui: j.ambigui ?? [], penzolanti: j.penzolanti ?? [], motivi: j.motivi ?? {}, motiviPenzolanti: j.motiviPenzolanti ?? {} };
}

const requirements = readRequirements();
const fileTest = readTests();

// NOT VACUOUS. If the file walk broke - a wrong path, a regex that no longer
// matches the spec format - every set would be empty and the gate would go
// green for the worst possible reason: because it looked at nothing. These two
// numbers are the proof that it looked.
if (requirements.length < 20) {
  console.error(`check:spec-coverage: only ${requirements.length} requirements read from ${SPECS} - the gate is measuring nothing.`);
  process.exit(2);
}
if (fileTest.length < 50) {
  console.error(`check:spec-coverage: only ${fileTest.length} test files with an id or @covers - the file walk is broken.`);
  process.exit(2);
}

/**
 * R6 - THE SAME ID DEFINED TWICE IN THE SPECS.
 *
 * `new Map(...)` keeps the LAST entry silently, which is how this stayed
 * invisible: the parse succeeded, the count looked right, and the first of the
 * two requirements simply stopped existing as far as this file was concerned.
 *
 * Measured 2026-08-25: `files/spec.md` defined `FILE-03` twice - "Reveal in
 * Finder" at :257 and "Process & Script Runner" at :281. One test declared
 * FILE-03 and BOTH looked covered, so the script runner appeared specified
 * while nothing pointed at it. Renumbering the second immediately turned the
 * gate red with "FILE-04 uncovered", which is the proof the duplicate was
 * hiding a hole rather than being a typo.
 *
 * R4 could not catch it: R4 asks whether one id is claimed by more than one
 * TEST. This asks whether the SPECS define it more than once, which is the
 * other half and the one that erases a requirement instead of blurring it.
 */
const definedTwice = (() => {
  const seen = new Map<string, string[]>();
  for (const r of requirements) seen.set(r.id, [...(seen.get(r.id) ?? []), `${r.file}: ${r.title}`]);
  return [...seen].filter(([, where]) => where.length > 1);
})();

const requirementById = new Map(requirements.map((r) => [r.id, r]));
const claimed = new Map<string, string[]>();
for (const t of fileTest) for (const c of t.covers) claimed.set(c, [...(claimed.get(c) ?? []), t.path]);

// R1 - a claim that resolves to no requirement.
const dangling: { id: string; file: string }[] = [];
for (const t of fileTest) for (const c of t.covers) if (!requirementById.has(c)) dangling.push({ id: c, file: t.path });

// R2 - a requirement nobody claims. Requirements the spec itself marks NOT
// BUILT are not debt: there is nothing to test. They are counted apart.
const notBuiltIds = requirements.filter((r) => r.notBuilt).map((r) => r.id);
const uncovered = requirements.filter((r) => !r.notBuilt && !claimed.has(r.id)).map((r) => r.id);
// R5 - the marker gone stale: it says nobody built it, and a test covers it.
const staleMarkers = requirements.filter((r) => r.notBuilt && claimed.has(r.id)).map((r) => r.id);

// R3 - requirement id used as a scenario title without claiming it.
const ambiguous: { id: string; file: string; requirement: string; scenario: string }[] = [];
for (const t of fileTest) {
  for (const { id, title } of t.titles) {
    const r = requirementById.get(id);
    if (r && !t.covers.includes(id)) ambiguous.push({ id, file: t.path, requirement: r.title, scenario: title });
  }
}

/**
 * `--json <path>` writes out the id -> test files map this gate builds anyway and then throws
 * away. It exists so the living-doc can say "KANBAN-34 is declared by these three files"
 * WITHOUT a second implementation of what counts as a declaration: two implementations drift,
 * and when they do, one of them is lying and nobody can tell which.
 *
 * It runs alongside the checks, never instead of them, so a map can only be produced by a run
 * that also passed judgement on the same data.
 */
/**
 * Per-FILE outcomes from a JUnit report (`bun test --reporter=junit --reporter-outfile=...`).
 *
 * WHY IT IS NEEDED. The Playwright report does not contain the unit tests, so the living-doc
 * read "covered, not run here" on 583 requirements out of 742 — requirements that in fact run
 * on every `bun run test:unit`. Without this step the page says almost everything is stalled,
 * and the easiest thing to conclude while looking at it is that the suite does not exist.
 *
 * The link stays PER FILE — `bun:test` has no per-test annotations like Playwright — so the
 * outcome says "this file's tests are green", not "this requirement is proven". The page paints
 * it in a colour of its own on purpose: promising more would be a green bought at a discount.
 */
function readJUnitOutcomes(path: string): Map<string, { outcome: "passed" | "failed"; tests: number }> {
  const out = new Map<string, { outcome: "passed" | "failed"; tests: number }>();
  if (!existsSync(path)) return out;
  const xml = readFileSync(path, "utf8");
  // The <testcase> elements are counted, not the <testsuite> ones: bun nests one testsuite per
  // describe, all carrying the same file= attribute, and summing them would count the same test
  // more than once.
  const re = /<testcase\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] ?? "";
    const fileM = /\bfile="([^"]*)"/.exec(attrs);
    if (!fileM) continue;
    const file = fileM[1]!.replace(/^\.\//, "").replace(/^\//, "");
    // Self-closed = passed. Otherwise the body says whether it is <failure> or <skipped>.
    let failed = false;
    if (m[2] !== "/") {
      const end = xml.indexOf("</testcase>", re.lastIndex);
      const body = end < 0 ? "" : xml.slice(re.lastIndex, end);
      failed = /<(failure|error)\b/.test(body);
    }
    const prev = out.get(file) ?? { outcome: "passed" as const, tests: 0 };
    out.set(file, { outcome: failed ? "failed" : prev.outcome, tests: prev.tests + 1 });
  }
  return out;
}

/**
 * Per-FILE outcomes from Playwright's JSON report.
 *
 * The twin of readJUnitOutcomes, for the other half of the suite. A requirement declared with
 * `@covers` by an e2e file that passes WHOLE has the same evidential force as one declared by a
 * green unit file: per file, not per requirement. Without this, the 43 requirements topics-app
 * covers only that way stayed "not run here" even after running the entire suite — because the
 * per-requirement outcome is born from the per-test annotations, and those files have none.
 *
 * `spec.file` in the report is relative to `config.rootDir` (the testDir), while the map's claims
 * are relative to the repo root: without rebuilding the prefix no key would match, silently and
 * with an error nowhere.
 */
function readPlaywrightOutcomes(path: string): Map<string, { outcome: "passed" | "failed"; tests: number }> {
  const out = new Map<string, { outcome: "passed" | "failed"; tests: number }>();
  if (!existsSync(path)) return out;
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return out;
  }
  const r = report as { config?: { rootDir?: string }; suites?: unknown[] };
  const rootDir = r.config?.rootDir ?? "";
  // relative() from cwd: if the report comes from another machine the prefix does not resolve,
  // and no outcome is preferred over an outcome attached to the wrong file.
  const prefix = rootDir ? relative(process.cwd(), rootDir).replaceAll("\\", "/") : "";
  type Spec = { file?: string; tests?: Array<{ status?: string }> };
  const specs: Spec[] = [];
  const walk = (node: { specs?: Spec[]; suites?: unknown[] }): void => {
    for (const sp of node.specs ?? []) specs.push(sp);
    for (const sub of node.suites ?? []) walk(sub as { specs?: Spec[]; suites?: unknown[] });
  };
  for (const su of r.suites ?? []) walk(su as { specs?: Spec[]; suites?: unknown[] });
  for (const sp of specs) {
    if (!sp.file) continue;
    const file = prefix ? `${prefix}/${sp.file}` : sp.file;
    // "flaky" = failed and then passed on retry: the final outcome is passed, the way the
    // toolkit reads it when it looks at the last attempt. "skipped" is neither a failure nor
    // evidence: it counts as a test run but does not move the outcome.
    const failed = (sp.tests ?? []).some((t) => t.status === "unexpected");
    const prev = out.get(file) ?? { outcome: "passed" as const, tests: 0 };
    out.set(file, { outcome: failed ? "failed" : prev.outcome, tests: prev.tests + (sp.tests?.length ?? 0) });
  }
  return out;
}

function writeCoverageMap(dest: string): void {
  const byId = new Map<string, { file: string; channel: "annotation" | "covers" }[]>();
  for (const t of fileTest) {
    for (const c of t.covers) {
      const channel = t.annotated.includes(c) ? "annotation" : "covers";
      byId.set(c, [...(byId.get(c) ?? []), { file: t.path.replace(/^\//, ""), channel }]);
    }
  }
  const junitFlag = process.argv.indexOf("--junit");
  const pwFlag = process.argv.indexOf("--pw-report");
  const outcomes = junitFlag >= 0 ? readJUnitOutcomes(process.argv[junitFlag + 1] ?? "") : new Map();
  // The two runners do not overlap (bun:test does not run tests/e2e), but were they ever to,
  // red wins: a file green under one runner and broken under the other is broken.
  if (pwFlag >= 0) {
    for (const [file, o] of readPlaywrightOutcomes(process.argv[pwFlag + 1] ?? "")) {
      const prev = outcomes.get(file);
      outcomes.set(file, prev ? { outcome: prev.outcome === "failed" || o.outcome === "failed" ? "failed" : "passed", tests: prev.tests + o.tests } : o);
    }
  }
  type Claim = { file: string; channel: string; outcome?: string; tests?: number };
  const requirementsOut: Record<string, { notBuilt: boolean; claims: Claim[] }> = {};
  for (const r of [...requirements].sort((a, b) => a.id.localeCompare(b.id))) {
    requirementsOut[r.id] = {
      notBuilt: r.notBuilt,
      claims: (byId.get(r.id) ?? [])
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((c): Claim => {
          const o = outcomes.get(c.file);
          return o ? { ...c, outcome: o.outcome, tests: o.tests } : { ...c };
        }),
    };
  }
  writeFileSync(dest, JSON.stringify({ version: 1, requirements: requirementsOut }, null, 2) + "\n");
  const withClaims = Object.values(requirementsOut).filter((r) => r.claims.length).length;
  const perTest = Object.values(requirementsOut).filter((r) => r.claims.some((c) => c.channel === "annotation")).length;
  console.log(`mappa di copertura -> ${dest}: ${Object.keys(requirementsOut).length} requisiti, ${withClaims} dichiarati, ${perTest} con una prova per-test`);
  if (outcomes.size) {
    const withUnit = Object.values(requirementsOut).filter((r) => r.claims.some((c) => c.outcome)).length;
    const redUnit = Object.values(requirementsOut).filter((r) => r.claims.some((c) => c.outcome === "failed")).length;
    console.log(`  esiti per file: ${outcomes.size} file di prova letti -> ${withUnit} requisiti con un esito${redUnit ? `, ${redUnit} con almeno un file rosso` : ""}`);
  }
}

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag >= 0) writeCoverageMap(process.argv[jsonFlag + 1] ?? "openspec/coverage-map.json");

const base = readBaseline();
const mode = process.argv.includes("--report") ? "report" : process.argv.includes("--write-baseline") ? "scrivi" : "cancello";

// -- Snapshot ---------------------------------------------------------------
const perCapability = new Map<string, { tot: number; covered: number }>();
for (const r of requirements) {
  if (r.notBuilt) continue; // no code, no bar to fill
  const v = perCapability.get(r.capability) ?? { tot: 0, covered: 0 };
  v.tot++;
  if (claimed.has(r.id)) v.covered++;
  perCapability.set(r.capability, v);
}
console.log(`Requisiti: ${requirements.length} in ${perCapability.size} capability · file di test letti: ${fileTest.length}`);
console.log(`Dichiarati coperti: ${requirements.length - uncovered.length - notBuiltIds.length}/${requirements.length - notBuiltIds.length}` +
  (notBuiltIds.length ? ` (${notBuiltIds.length} requisiti marcati NOT BUILT restano fuori dal conto: non c'e' codice da provare)` : ""));
console.log("");
for (const [cap, v] of [...perCapability].sort((a, b) => a[1].covered / a[1].tot - b[1].covered / b[1].tot)) {
  const bar = v.covered === v.tot ? "pieno" : `${v.covered}/${v.tot}`;
  console.log(`  ${cap.padEnd(24)} ${bar}`);
}

if (mode === "scrivi") {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _perche:
          "Il debito di tracciabilita' NOTO al momento in cui il cancello e' nato. Non e' un permesso: e' una lista che deve scendere. Una voce che non e' piu' violata fa fallire il cancello, cosi' si toglie invece di restare.",
        _quando: new Date().toISOString().slice(0, 10),
        motivi: Object.fromEntries(Object.entries(readBaseline().motivi).filter(([id]) => uncovered.includes(id))),
        motiviPenzolanti: readBaseline().motiviPenzolanti,
        scoperti: [...uncovered].sort(),
        ambigui: [...new Set(ambiguous.map((a) => `${a.id}@${a.file}`))].sort(),
        penzolanti: [...new Set(dangling.map((p) => `${p.id}@${p.file}`))].sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nLinea di partenza scritta in ${BASELINE.slice(ROOT.length)}: ${uncovered.length} scoperti, ${new Set(ambiguous.map((a) => `${a.id}@${a.file}`)).size} ambigui.`);
  process.exit(0);
}

// -- Verdict ----------------------------------------------------------------
const ambiguousKeys = [...new Set(ambiguous.map((a) => `${a.id}@${a.file}`))];
const danglingKeys = [...new Set(dangling.map((p) => `${p.id}@${p.file}`))];
const newUncovered = uncovered.filter((id) => !base.scoperti.includes(id));
const newAmbiguous = ambiguousKeys.filter((k) => !base.ambigui.includes(k));
const newDangling = danglingKeys.filter((k) => !base.penzolanti.includes(k));
const resolved = [
  ...base.scoperti.filter((id) => !uncovered.includes(id)),
  ...base.ambigui.filter((k) => !ambiguousKeys.includes(k)),
  ...base.penzolanti.filter((k) => !danglingKeys.includes(k)),
];

let red = false;

// R4 - a scenario id must name exactly ONE test, across the whole suite.
const perId = new Map<string, string[]>();
for (const t of fileTest) {
  for (const { id, title } of t.titles) {
    perId.set(id, [...(perId.get(id) ?? []), `${t.path.replace(/^\//, "")} — ${title.slice(0, 54)}`]);
  }
}
const notUnique = [...perId].filter(([, v]) => v.length > 1);
if (notUnique.length) {
  red = true;
  console.log(`\nR4 — lo stesso id nomina piu' di un test (${notUnique.length}):`);
  for (const [id, where] of notUnique) {
    console.log(`  ${id}`);
    for (const d of where) console.log(`      ${d}`);
  }
  console.log("  → la convenzione per una variante dello stesso scenario e' il suffisso (TOPBAR-04 / TOPBAR-04b).");
}

if (muteAnnotations.length) {
  red = true;
  console.log(`\nR7 — annotazioni \`spec\` che non nominano nessun requisito (${muteAnnotations.length}):`);
  for (const a of muteAnnotations) console.log(`  ${a.desc.padEnd(30)} in ${a.file}`);
  console.log("  → non dichiarano niente e non lo dice nessuno: o l'id e' sbagliato, o va tolta l'annotazione.");
}
if (newDangling.length) {
  red = true;
  console.log(`\nR1 — un test dichiara un requisito che le spec non hanno (${newDangling.length} nuovi):`);
  for (const k of newDangling) console.log(`  ${k.split("@")[0]!.padEnd(18)} dichiarato da ${k.split("@")[1]}`);
  console.log("  → o l'id e' sbagliato, o il requisito va scritto: il test lo prova gia'.");
}
if (newUncovered.length) {
  red = true;
  console.log(`\nR2 — requisiti NUOVI che nessun test dichiara di coprire (${newUncovered.length}):`);
  for (const id of newUncovered) console.log(`  ${id.padEnd(18)} ${requirementById.get(id)!.title}`);
  console.log("  → aggiungi `@covers <ID>` nel commento di testa del test che lo esercita.");
}
if (newAmbiguous.length) {
  red = true;
  console.log(`\nR3 — id di requisito usato come titolo di scenario senza dichiararlo (${newAmbiguous.length}):`);
  for (const k of newAmbiguous) {
    const a = ambiguous.find((x) => `${x.id}@${x.file}` === k)!;
    console.log(`  ${a.id.padEnd(14)} ${a.file}`);
    console.log(`  ${" ".repeat(14)} il requisito dice: ${a.requirement}`);
    console.log(`  ${" ".repeat(14)} il test prova:     ${a.scenario}`);
  }
}
if (definedTwice.length) {
  red = true;
  console.log(`\nR6 — lo stesso id e' definito piu' di una volta nelle spec (${definedTwice.length}):`);
  for (const [id, where] of definedTwice) {
    console.log(`  ${id.padEnd(18)} definito ${where.length} volte:`);
    for (const w of where) console.log(`  ${" ".repeat(18)}   ${w}`);
  }
  console.log("  → rinumera il secondo. Un id che nomina due requisiti non si puo' dichiarare");
  console.log("    onestamente: chi lo dichiara ne copre uno e l'altro sembra coperto.");
  console.log("  Nessuna linea di partenza qui: e' sempre un errore, e la cura e' di un minuto.");
}
if (staleMarkers.length) {
  red = true;
  console.log(`\nR5 — un requisito marcato NOT BUILT ha un test che lo copre (${staleMarkers.length}):`);
  for (const id of staleMarkers) console.log(`  ${id.padEnd(18)} ${requirementById.get(id)!.file}`);
  console.log("  → qualcuno l'ha costruito: togli la riga `**Status: NOT BUILT**` dalla spec.");
  console.log("  Nessuna linea di partenza qui: un marcatore che sopravvive a cio' che descrive e' sempre un errore.");
}
if (resolved.length) {
  red = true;
  console.log(`\nLinea di partenza stantia — queste voci non sono piu' violate, vanno tolte (${resolved.length}):`);
  for (const k of resolved) console.log(`  ${k}`);
  console.log("  → bun run scripts/check-spec-coverage.ts --write-baseline");
}

const withoutReason = uncovered.filter((id) => !base.motivi[id]);
if (mode === "report") {
  const withReason = uncovered.filter((id) => base.motivi[id]);
  if (withReason.length) {
    console.log(`\nScoperti CON un motivo scritto (${withReason.length}):`);
    for (const id of withReason) console.log(`  ${id.padEnd(14)} ${base.motivi[id]}`);
  }
  console.log(`Scoperti senza motivo: ${withoutReason.length} — sono debito, non deroghe.`);
  // Dangling claims are not one thing, and treating them as one hides that the
  // cure differs per group: promote the requirement, build the feature, or stop
  // declaring an id that was never a requirement.
  const groups = new Map<string, string[]>();
  for (const k of danglingKeys) {
    const id = k.split("@")[0]!;
    const g = base.motiviPenzolanti[id.replace(/-\d+[a-z]?$/, "")] ?? "non classificato";
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  console.log(`\nPenzolanti per cura (${danglingKeys.length}):`);
  for (const [cure, ids] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(3)}  ${cure}`);
  }
  console.log(`\n(report) scoperti: ${uncovered.length} · ambigui: ${ambiguousKeys.length} · penzolanti: ${danglingKeys.length}`);
  process.exit(0);
}
if (red) process.exit(1);
console.log(`\nVerde. Debito noto: ${base.scoperti.length} scoperti, ${base.ambigui.length} ambigui, ${base.penzolanti.length} penzolanti — e non e' cresciuto.`);
