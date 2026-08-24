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
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SPECS = join(ROOT, "openspec", "specs");
const BASELINE = join(ROOT, "openspec", "coverage-baseline.json");

/** Roots where a test can live. Outside these, a `@covers` is never seen. */
const TEST_ROOTS = ["tests", "client/src", "server", "shared", "relay", "cli", "scripts"];

type Requisito = { id: string; capability: string; titolo: string; file: string };
type FileTest = { path: string; covers: string[]; titoli: { id: string; testo: string }[] };

function cammina(dir: string, out: string[] = []): string[] {
  let voci: string[];
  try {
    voci = readdirSync(dir);
  } catch {
    return out;
  }
  for (const nome of voci) {
    if (nome === "node_modules" || nome === ".git" || nome === "dist" || nome === "data") continue;
    const p = join(dir, nome);
    try {
      if (statSync(p).isDirectory()) cammina(p, out);
      else out.push(p);
    } catch {
      /* a broken link or a file that vanished mid-walk is not a gate failure */
    }
  }
  return out;
}

/** Declared requirements: `### Requirement: CAP-nn — title`. */
function leggiRequisiti(): Requisito[] {
  const fuori: Requisito[] = [];
  for (const f of cammina(SPECS)) {
    if (!f.endsWith(".md")) continue;
    const capability = f.slice(SPECS.length + 1).split("/")[0]!;
    const testo = readFileSync(f, "utf8");
    for (const m of testo.matchAll(/^###\s+Requirement:\s*([A-Z][A-Z0-9]*(?:-[A-Z]+)*-\d+[a-z]?)\s*[—–-]*\s*(.*)$/gm)) {
      fuori.push({ id: m[1]!, capability, titolo: (m[2] ?? "").trim(), file: f.slice(ROOT.length) });
    }
  }
  return fuori;
}

/** One test file: what it claims to cover, and the ids it names its scenarios with. */
function leggiTest(): FileTest[] {
  const fuori: FileTest[] = [];
  for (const radice of TEST_ROOTS) {
    for (const f of cammina(join(ROOT, radice))) {
      if (!/\.(test|spec)\.(ts|tsx)$/.test(f)) continue;
      const testo = readFileSync(f, "utf8");
      // TWO channels, because the two runners do not have the same tool.
      //
      //  - Playwright: `test.info().annotations.push({type:"spec", ...})`. This
      //    is the convention ALREADY IN USE here (274 tests, 45 files) and it
      //    lives on the single scenario. It was not invented for this gate: a
      //    gate that ignores the house convention forces the same fact to be
      //    declared twice.
      //  - bun test: `test.info()` does not exist, so for unit tests the link
      //    is a `@covers` in the header comment, at FILE granularity.
      const daAnnotation = [...testo.matchAll(/type:\s*["']spec["']\s*,\s*description:\s*["'`]([^"'`]+)["'`]/g)]
        .flatMap((m) => m[1]!.split(/[,\s/]+/))
        .filter((s: string) => /^[A-Z][A-Z0-9-]*-\d+[a-z]?$/.test(s));
      const daCovers = [...testo.matchAll(/@covers\s+([A-Z0-9,\s-]+)/g)]
        .flatMap((m) => m[1]!.split(/[,\s]+/))
        .filter((s: string) => /^[A-Z][A-Z0-9-]*-\d+[a-z]?$/.test(s));
      const covers = [...new Set([...daAnnotation, ...daCovers])];
      const titoli = [...testo.matchAll(/\b(?:test|it)\(\s*["'`]([A-Z][A-Z0-9]*(?:-[A-Z]+)*-\d+[a-z]?)[^"'`]*?:\s*([^"'`]{0,90})/g)].map(
        (m) => ({ id: m[1]!, testo: (m[2] ?? "").trim() }),
      );
      if (covers.length || titoli.length) fuori.push({ path: f.slice(ROOT.length), covers, titoli });
    }
  }
  return fuori;
}

type Baseline = { scoperti: string[]; ambigui: string[]; penzolanti: string[]; motivi: Record<string, string> };

function leggiBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { scoperti: [], ambigui: [], penzolanti: [], motivi: {} };
  const j = JSON.parse(readFileSync(BASELINE, "utf8")) as Partial<Baseline>;
  return { scoperti: j.scoperti ?? [], ambigui: j.ambigui ?? [], penzolanti: j.penzolanti ?? [], motivi: j.motivi ?? {} };
}

const requisiti = leggiRequisiti();
const fileTest = leggiTest();

// NOT VACUOUS. If the file walk broke - a wrong path, a regex that no longer
// matches the spec format - every set would be empty and the gate would go
// green for the worst possible reason: because it looked at nothing. These two
// numbers are the proof that it looked.
if (requisiti.length < 20) {
  console.error(`check:spec-coverage: only ${requisiti.length} requirements read from ${SPECS} - the gate is measuring nothing.`);
  process.exit(2);
}
if (fileTest.length < 50) {
  console.error(`check:spec-coverage: only ${fileTest.length} test files with an id or @covers - the file walk is broken.`);
  process.exit(2);
}

const idRequisito = new Map(requisiti.map((r) => [r.id, r]));
const dichiarati = new Map<string, string[]>();
for (const t of fileTest) for (const c of t.covers) dichiarati.set(c, [...(dichiarati.get(c) ?? []), t.path]);

// R1 - a claim that resolves to no requirement.
const penzolanti: { id: string; file: string }[] = [];
for (const t of fileTest) for (const c of t.covers) if (!idRequisito.has(c)) penzolanti.push({ id: c, file: t.path });

// R2 - a requirement nobody claims.
const scoperti = requisiti.filter((r) => !dichiarati.has(r.id)).map((r) => r.id);

// R3 - requirement id used as a scenario title without claiming it.
const ambigui: { id: string; file: string; requisito: string; scenario: string }[] = [];
for (const t of fileTest) {
  for (const { id, testo } of t.titoli) {
    const r = idRequisito.get(id);
    if (r && !t.covers.includes(id)) ambigui.push({ id, file: t.path, requisito: r.titolo, scenario: testo });
  }
}

const base = leggiBaseline();
const modo = process.argv.includes("--report") ? "report" : process.argv.includes("--write-baseline") ? "scrivi" : "cancello";

// -- Snapshot ---------------------------------------------------------------
const perCapability = new Map<string, { tot: number; coperti: number }>();
for (const r of requisiti) {
  const v = perCapability.get(r.capability) ?? { tot: 0, coperti: 0 };
  v.tot++;
  if (dichiarati.has(r.id)) v.coperti++;
  perCapability.set(r.capability, v);
}
console.log(`Requisiti: ${requisiti.length} in ${perCapability.size} capability · file di test letti: ${fileTest.length}`);
console.log(`Dichiarati coperti: ${requisiti.length - scoperti.length}/${requisiti.length}`);
console.log("");
for (const [cap, v] of [...perCapability].sort((a, b) => a[1].coperti / a[1].tot - b[1].coperti / b[1].tot)) {
  const barra = v.coperti === v.tot ? "pieno" : `${v.coperti}/${v.tot}`;
  console.log(`  ${cap.padEnd(24)} ${barra}`);
}

if (modo === "scrivi") {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _perche:
          "Il debito di tracciabilita' NOTO al momento in cui il cancello e' nato. Non e' un permesso: e' una lista che deve scendere. Una voce che non e' piu' violata fa fallire il cancello, cosi' si toglie invece di restare.",
        _quando: new Date().toISOString().slice(0, 10),
        motivi: Object.fromEntries(Object.entries(leggiBaseline().motivi).filter(([id]) => scoperti.includes(id))),
        scoperti: [...scoperti].sort(),
        ambigui: [...new Set(ambigui.map((a) => `${a.id}@${a.file}`))].sort(),
        penzolanti: [...new Set(penzolanti.map((p) => `${p.id}@${p.file}`))].sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nLinea di partenza scritta in ${BASELINE.slice(ROOT.length)}: ${scoperti.length} scoperti, ${new Set(ambigui.map((a) => `${a.id}@${a.file}`)).size} ambigui.`);
  process.exit(0);
}

// -- Verdict ----------------------------------------------------------------
const chiaviAmbigue = [...new Set(ambigui.map((a) => `${a.id}@${a.file}`))];
const chiaviPenzolanti = [...new Set(penzolanti.map((p) => `${p.id}@${p.file}`))];
const nuoviScoperti = scoperti.filter((id) => !base.scoperti.includes(id));
const nuoviAmbigui = chiaviAmbigue.filter((k) => !base.ambigui.includes(k));
const nuoviPenzolanti = chiaviPenzolanti.filter((k) => !base.penzolanti.includes(k));
const risolti = [
  ...base.scoperti.filter((id) => !scoperti.includes(id)),
  ...base.ambigui.filter((k) => !chiaviAmbigue.includes(k)),
  ...base.penzolanti.filter((k) => !chiaviPenzolanti.includes(k)),
];

let rosso = false;

if (nuoviPenzolanti.length) {
  rosso = true;
  console.log(`\nR1 — un test dichiara un requisito che le spec non hanno (${nuoviPenzolanti.length} nuovi):`);
  for (const k of nuoviPenzolanti) console.log(`  ${k.split("@")[0]!.padEnd(18)} dichiarato da ${k.split("@")[1]}`);
  console.log("  → o l'id e' sbagliato, o il requisito va scritto: il test lo prova gia'.");
}
if (nuoviScoperti.length) {
  rosso = true;
  console.log(`\nR2 — requisiti NUOVI che nessun test dichiara di coprire (${nuoviScoperti.length}):`);
  for (const id of nuoviScoperti) console.log(`  ${id.padEnd(18)} ${idRequisito.get(id)!.titolo}`);
  console.log("  → aggiungi `@covers <ID>` nel commento di testa del test che lo esercita.");
}
if (nuoviAmbigui.length) {
  rosso = true;
  console.log(`\nR3 — id di requisito usato come titolo di scenario senza dichiararlo (${nuoviAmbigui.length}):`);
  for (const k of nuoviAmbigui) {
    const a = ambigui.find((x) => `${x.id}@${x.file}` === k)!;
    console.log(`  ${a.id.padEnd(14)} ${a.file}`);
    console.log(`  ${" ".repeat(14)} il requisito dice: ${a.requisito}`);
    console.log(`  ${" ".repeat(14)} il test prova:     ${a.scenario}`);
  }
}
if (risolti.length) {
  rosso = true;
  console.log(`\nLinea di partenza stantia — queste voci non sono piu' violate, vanno tolte (${risolti.length}):`);
  for (const k of risolti) console.log(`  ${k}`);
  console.log("  → bun run scripts/check-spec-coverage.ts --write-baseline");
}

const senzaMotivo = scoperti.filter((id) => !base.motivi[id]);
if (modo === "report") {
  const conMotivo = scoperti.filter((id) => base.motivi[id]);
  if (conMotivo.length) {
    console.log(`\nScoperti CON un motivo scritto (${conMotivo.length}):`);
    for (const id of conMotivo) console.log(`  ${id.padEnd(14)} ${base.motivi[id]}`);
  }
  console.log(`Scoperti senza motivo: ${senzaMotivo.length} — sono debito, non deroghe.`);
  console.log(`\n(report) scoperti: ${scoperti.length} · ambigui: ${chiaviAmbigue.length} · penzolanti: ${chiaviPenzolanti.length}`);
  process.exit(0);
}
if (rosso) process.exit(1);
console.log(`\nVerde. Debito noto: ${base.scoperti.length} scoperti, ${base.ambigui.length} ambigui, ${base.penzolanti.length} penzolanti — e non e' cresciuto.`);
