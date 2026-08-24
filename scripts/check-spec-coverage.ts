#!/usr/bin/env bun
/**
 * TRACCIABILITA' SPEC ↔ TEST: un requisito senza test, e un test che dice di
 * coprire un requisito che non esiste.
 *
 * PERCHE' ESISTE. «I test coprono tutto» non e' verificabile finche' non c'e'
 * un denominatore. Qui il denominatore sono i requisiti dichiarati in
 * `openspec/specs/`, e il legame e' una riga che il test scrive di suo pugno.
 *
 * IL GUASTO CHE HA FATTO NASCERE QUESTO FILE, misurato il 25/08/2026: gli id
 * dei requisiti e gli id degli scenari nei test vivono nella STESSA sintassi
 * (`CAP-nn`) ma sono due contatori diversi, e nessuno li teneva separati.
 * Risultato: 24 id che significano due cose. `CMD-02` per la spec e' «Push
 * Notifications», per `command-palette.spec.ts` e' «topic search filters and
 * navigates»; `CMD-03` e' «Reopen most recently closed tab» per una e «theme
 * toggle» per l'altro; `TERM-02` e' «Reload a Terminal Session In Place» e
 * «terminal accepts keyboard input». Chi legge «CMD-03 verde» non sa che cosa
 * e' stato provato, e il requisito vero puo' non avere nessun test — cosa che
 * questo cancello ora dice a voce alta.
 *
 * LE TRE INVARIANTI.
 *
 *   R1 PENZOLANTE — un `@covers <ID>` che non risolve a nessun requisito.
 *      Bloccante SEMPRE, senza baseline: oggi vale zero, quindi nasce verde e
 *      il primo che sbaglia un id lo scopre subito. E' l'unica delle tre che
 *      puo' mordere il giorno stesso in cui viene scritta.
 *
 *   R2 SCOPERTO — un requisito che nessun test dichiara di coprire. Non e'
 *      bloccante di per se': lo e' il PEGGIORAMENTO rispetto alla linea di
 *      partenza committata. Un requisito nuovo senza test fa rosso; il debito
 *      gia' noto no, finche' non cresce.
 *
 *   R3 AMBIGUO — un id di requisito usato come prefisso di titolo in un test
 *      che NON dichiara di coprirlo. E' lo scontro descritto sopra. Anche qui
 *      la linea di partenza fotografa il debito e il cancello impedisce che
 *      aumenti.
 *
 * LA LINEA DI PARTENZA SI CONSUMA. `coverage-baseline.json` elenca le
 * violazioni tollerate, e una voce che non e' piu' violata fa fallire il
 * cancello: cosi' la lista scende invece di restare li' a coprire un debito
 * gia' pagato. E' la differenza fra una linea di partenza e un tappeto.
 *
 * COME SI DICHIARA. Nel commento di testa del file di test:
 *
 *     @covers KANBAN-01, KANBAN-02
 *
 * Un file, i requisiti che esercita. La granularita' e' il FILE e non il
 * singolo `test(...)` di proposito: e' la stessa scelta di `spec-resolve.ts`
 * («la risoluzione stabile che i dati supportano e' a granularita' feature»),
 * e un id per scenario si sfalderebbe al primo rinomino.
 *
 *   bun run scripts/check-spec-coverage.ts            # cancello (exit 1 se rosso)
 *   bun run scripts/check-spec-coverage.ts --report   # solo la fotografia
 *   bun run scripts/check-spec-coverage.ts --write-baseline
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SPECS = join(ROOT, "openspec", "specs");
const BASELINE = join(ROOT, "openspec", "coverage-baseline.json");

/** Le radici in cui vive un test. Fuori da qui un `@covers` non viene visto. */
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
      /* un link rotto o un file sparito sotto i piedi non e' un guasto del cancello */
    }
  }
  return out;
}

/** I requisiti dichiarati: `### Requirement: CAP-nn — titolo`. */
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

/** Un file di test: che cosa dichiara di coprire, e con che id nomina i suoi scenari. */
function leggiTest(): FileTest[] {
  const fuori: FileTest[] = [];
  for (const radice of TEST_ROOTS) {
    for (const f of cammina(join(ROOT, radice))) {
      if (!/\.(test|spec)\.(ts|tsx)$/.test(f)) continue;
      const testo = readFileSync(f, "utf8");
      const covers = [
        ...new Set(
          [...testo.matchAll(/@covers\s+([A-Z0-9,\s-]+)/g)].flatMap((m) =>
            m[1]!.split(/[,\s]+/).filter((s: string) => /^[A-Z][A-Z0-9-]*-\d+[a-z]?$/.test(s)),
          ),
        ),
      ];
      const titoli = [...testo.matchAll(/\b(?:test|it)\(\s*["'`]([A-Z][A-Z0-9]*(?:-[A-Z]+)*-\d+[a-z]?)[^"'`]*?:\s*([^"'`]{0,90})/g)].map(
        (m) => ({ id: m[1]!, testo: (m[2] ?? "").trim() }),
      );
      if (covers.length || titoli.length) fuori.push({ path: f.slice(ROOT.length), covers, titoli });
    }
  }
  return fuori;
}

type Baseline = { scoperti: string[]; ambigui: string[] };

function leggiBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { scoperti: [], ambigui: [] };
  const j = JSON.parse(readFileSync(BASELINE, "utf8")) as Partial<Baseline>;
  return { scoperti: j.scoperti ?? [], ambigui: j.ambigui ?? [] };
}

const requisiti = leggiRequisiti();
const fileTest = leggiTest();

// NON VACUO. Se il giro dei file si rompesse — un percorso sbagliato, una
// regex che non aggancia piu' il formato delle spec — ogni insieme sarebbe
// vuoto e il cancello direbbe verde per il motivo peggiore: perche' non ha
// guardato niente. Questi due numeri sono la prova che ha guardato.
if (requisiti.length < 20) {
  console.error(`check:spec-coverage: letti solo ${requisiti.length} requisiti da ${SPECS} — il cancello non sta misurando niente.`);
  process.exit(2);
}
if (fileTest.length < 50) {
  console.error(`check:spec-coverage: trovati solo ${fileTest.length} file di test con id o @covers — il giro dei file e' rotto.`);
  process.exit(2);
}

const idRequisito = new Map(requisiti.map((r) => [r.id, r]));
const dichiarati = new Map<string, string[]>();
for (const t of fileTest) for (const c of t.covers) dichiarati.set(c, [...(dichiarati.get(c) ?? []), t.path]);

// R1 — @covers che non risolve.
const penzolanti: { id: string; file: string }[] = [];
for (const t of fileTest) for (const c of t.covers) if (!idRequisito.has(c)) penzolanti.push({ id: c, file: t.path });

// R2 — requisito che nessuno dichiara di coprire.
const scoperti = requisiti.filter((r) => !dichiarati.has(r.id)).map((r) => r.id);

// R3 — id di requisito usato come titolo di scenario senza dichiararlo.
const ambigui: { id: string; file: string; requisito: string; scenario: string }[] = [];
for (const t of fileTest) {
  for (const { id, testo } of t.titoli) {
    const r = idRequisito.get(id);
    if (r && !t.covers.includes(id)) ambigui.push({ id, file: t.path, requisito: r.titolo, scenario: testo });
  }
}

const base = leggiBaseline();
const modo = process.argv.includes("--report") ? "report" : process.argv.includes("--write-baseline") ? "scrivi" : "cancello";

// ── Fotografia ──────────────────────────────────────────────────────────────
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
        scoperti: [...scoperti].sort(),
        ambigui: [...new Set(ambigui.map((a) => `${a.id}@${a.file}`))].sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nLinea di partenza scritta in ${BASELINE.slice(ROOT.length)}: ${scoperti.length} scoperti, ${new Set(ambigui.map((a) => `${a.id}@${a.file}`)).size} ambigui.`);
  process.exit(0);
}

// ── Verdetto ────────────────────────────────────────────────────────────────
const chiaviAmbigue = [...new Set(ambigui.map((a) => `${a.id}@${a.file}`))];
const nuoviScoperti = scoperti.filter((id) => !base.scoperti.includes(id));
const nuoviAmbigui = chiaviAmbigue.filter((k) => !base.ambigui.includes(k));
const risolti = [...base.scoperti.filter((id) => !scoperti.includes(id)), ...base.ambigui.filter((k) => !chiaviAmbigue.includes(k))];

let rosso = false;

if (penzolanti.length) {
  rosso = true;
  console.log(`\nR1 — @covers che non risolve a nessun requisito (${penzolanti.length}):`);
  for (const p of penzolanti) console.log(`  ${p.id.padEnd(18)} dichiarato da ${p.file}`);
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

if (modo === "report") {
  console.log(`\n(report) scoperti: ${scoperti.length} · ambigui: ${chiaviAmbigue.length} · penzolanti: ${penzolanti.length}`);
  process.exit(0);
}
if (rosso) process.exit(1);
console.log(`\nVerde. Debito noto: ${base.scoperti.length} scoperti, ${base.ambigui.length} ambigui — e non e' cresciuto.`);
