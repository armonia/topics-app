#!/usr/bin/env bun
/**
 * scripts/ui-fixtures-check.ts - the numbers of the organizations preview
 * agree with each other, and every date is computed right.
 *
 * WHY. The preview is read by people who check numbers: a director who sees
 * 1.910 in one tile and 1.907 in the sum below stops trusting the rest; a
 * lawyer who sees a deadline one day off stops trusting all of them. The
 * screens derive what they can from the same data, and this gate checks the
 * rest, the declared estimates and the facts written in the fixtures:
 *
 *  · every deadline of every case equals `dueDate(from, days, rollsOver)`;
 *  · every value the AI read quotes words that are really on that page of
 *    that document, and every original exists as a file (pages and PDF);
 *  · invoices: VAT and totals add up;
 *  · the overview as the screen computes it, for week, month and year: the
 *    volume tile equals the sum of the flow rows, equals the sum of the bars;
 *    each month row matches its flow in the flow catalogue; every active flow
 *    is in it; its «ferme» tile is the queue the sidebar counts;
 *  · the month errors of a flow are the same on its page and in the overview;
 *  · the PEC types of the sector package add up to the PEC flow's month;
 *  · every case's flow exists, every flow step a case cites exists in it;
 *  · every Board card that names a case or a procedure points to one that exists.
 *
 *   bun run scripts/ui-fixtures-check.ts
 *
 * Exit 0: all agree. Exit 1: the list of what does not, one line each.
 */
import { existsSync } from "node:fs";
/* The copy reads the world while it loads: SARIM is chosen before anything imports it. */
import "../client/src/ui-gallery/use-sarim-world";
import { join, resolve } from "node:path";
import { CASES } from "../client/src/ui/fixtures/org/cases";
import { FLOWS } from "../client/src/ui/fixtures/org/flows";
import { dueDate } from "../client/src/ui/fixtures/org/clock";
import { FLOW_STATS } from "../client/src/ui/fixtures/overview";
import { FLOW_FACTS } from "../client/src/ui/fixtures/flow-build";
import { SECTOR_PACKAGES } from "../client/src/ui/fixtures/settings";
import { SARIM_FLOWS } from "../client/src/ui/fixtures/sarim";
import { BOARD_TASKS } from "../client/src/ui/fixtures/board";
import { PROCEDURES } from "../client/src/ui/fixtures/knowledge-more-procedures";
import { itemById, findArticle } from "../client/src/ui/fixtures/knowledge-more";

const PROCEDURE_IDS = new Set(PROCEDURES.map((p) => p.id));
import { PERSONAS } from "../client/src/ui/fixtures/org/people";
import { UI_COPY_IT } from "../client/src/ui/copy/i18n-ui-it";
import { buildOverview, overviewFlows } from "../client/src/ui-gallery/app/screens/orgs/overview-model";
import { initialState } from "../client/src/ui-gallery/app/store/state";
import { queueFor } from "../client/src/ui-gallery/app/store/cases";
import { checkSarimCards } from "./ui-fixtures/sarim-cards";
import { checkSarimContracts } from "./ui-fixtures/sarim-contracts";

const ROOT = resolve(import.meta.dir, "..");
const PUBLIC = join(ROOT, "client/public-ui");
const problems: string[] = [];
let checks = 0;
const check = (ok: boolean, msg: string) => {
  checks++;
  if (!ok) problems.push(msg);
};

const parseNumber = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/* ---- cases ---- */
for (const c of CASES) {
  for (const d of c.deadlines) {
    const want = dueDate(d.from, d.days, d.rollsOver);
    check(d.date === want, `pratica ${c.id}, scadenza «${d.label}»: scritta ${d.date}, calcolata ${want} (${d.days} giorni da ${d.from}${d.rollsOver ? ", slitta" : ""})`);
  }
  for (const doc of c.documents) {
    for (const p of doc.pages) check(existsSync(join(PUBLIC, p)), `pratica ${c.id}, documento ${doc.id}: manca la pagina ${p}`);
    if (doc.pdf) check(existsSync(join(PUBLIC, doc.pdf)), `pratica ${c.id}, documento ${doc.id}: manca il PDF ${doc.pdf}`);
    check(doc.text.length === doc.pages.length, `pratica ${c.id}, documento ${doc.id}: ${doc.pages.length} pagine ma ${doc.text.length} testi`);
    for (const s of doc.summary) check(s.page >= 1 && s.page <= doc.pages.length, `pratica ${c.id}, documento ${doc.id}: il riassunto cita la pagina ${s.page}`);
  }
  for (const f of c.fields) {
    const doc = c.documents.find((d) => d.id === f.source.doc);
    const text = doc?.text[f.source.page - 1];
    check(!!text, `pratica ${c.id}, campo ${f.id}: la fonte ${f.source.doc} p.${f.source.page} non esiste`);
    if (text) {
      const quote = norm(`${f.source.before}${f.source.highlight}${f.source.after}`);
      check(norm(text).includes(norm(f.source.highlight)), `pratica ${c.id}, campo ${f.id}: «${f.source.highlight}» non è nel testo di ${f.source.doc} p.${f.source.page}`);
      check(norm(text).includes(quote), `pratica ${c.id}, campo ${f.id}: la citazione intera non è nel testo di ${f.source.doc} p.${f.source.page}`);
    }
  }
  const flow = FLOWS.find((f) => f.id === c.flow);
  check(!!flow, `pratica ${c.id}: il flusso ${c.flow} non esiste`);
  if (flow && c.flow !== "pec") {
    for (const s of c.steps) {
      if (s.flowStep) check(flow.steps.some((x: { id: string }) => x.id === s.flowStep), `pratica ${c.id}: il passo ${s.flowStep} non è nel flusso ${c.flow}`);
    }
  }
  check(c.example === true, `pratica ${c.id}: non è dichiarata di esempio`);
  /* every norm a case cites opens a real page of Conoscenza, at the article it names */
  for (const n of c.norms ?? []) {
    const [itemId, article] = n.split("/");
    const item = itemById(itemId);
    check(!!item, `pratica ${c.id}: cita ${n}, ma ${itemId} non è in Conoscenza`);
    if (item && article) check(!!findArticle(item, article), `pratica ${c.id}: cita ${n}, ma l'articolo ${article} non è nel testo di ${itemId}`);
  }
}

/* ---- invoices ---- */
for (const c of CASES.filter((x) => x.kind === "fattura")) {
  const fields = Object.fromEntries(c.fields.map((f) => [f.id, f.value]));
  const net = fields.imponibile ? parseNumber(fields.imponibile.replace(/[^\d.,]/g, "")) : undefined;
  const vat = fields.iva ? parseNumber(fields.iva.replace(/[^\d.,]/g, "")) : undefined;
  const total = fields.totale ? parseNumber(fields.totale.replace(/[^\d.,]/g, "")) : undefined;
  if (net !== undefined && vat !== undefined) check(Math.abs(net * 0.22 - vat) < 0.011, `fattura ${c.id}: IVA ${vat} non è il 22% di ${net}`);
  if (net !== undefined && vat !== undefined && total !== undefined) check(Math.abs(net + vat - total) < 0.011, `fattura ${c.id}: ${net} + ${vat} non fa ${total}`);
}

/* ---- overview: what the n18 screen really computes, for each period ---- */
const state = initialState();
for (const period of ["week", "month", "year"] as const) {
  const o = buildOverview(state, period, UI_COPY_IT);
  const tile = o.model.tiles.find((t) => t.id === "k-volume");
  const rows = o.model.flows.reduce((n, f) => n + parseNumber(f.perMonth), 0);
  const days = o.model.chart.days.reduce((n, d) => n + d.value, 0);
  check(!!tile && parseNumber(tile.value) === rows, `panoramica (${period}): il riquadro dice ${tile?.value}, le righe fanno ${rows}`);
  check(days === rows, `panoramica (${period}): le barre fanno ${days}, le righe ${rows}`);
  if (period === "month") {
    for (const r of o.rows) {
      check(r.volume === r.flow.perMonth, `panoramica: ${r.id} dice ${r.volume} al mese, il catalogo dei flussi ${r.flow.perMonth}`);
    }
    const stuck = o.model.tiles.find((t) => t.id === "k-stuck");
    const owner = PERSONAS.find((p) => p.id === "attilio")!;
    const queue = queueFor(state, owner, "nocera").length;
    check(Number(stuck?.value) === queue, `panoramica: «ferme» dice ${stuck?.value}, la coda di Da fare ne ha ${queue}`);
  }
}
for (const f of FLOWS.filter((x) => x.org === "nocera" && x.status === "attivo")) {
  check(overviewFlows().some((r) => r.id === f.id), `panoramica: manca il flusso attivo ${f.id}`);
}
/* the same month errors on the flow page and in the overview */
for (const [id, s] of Object.entries(FLOW_STATS)) {
  const facts = FLOW_FACTS[id];
  if (facts) check(facts.errors === s.errors, `errori a 30 giorni di ${id}: la pagina del flusso dice ${facts.errors}, la panoramica ${s.errors}`);
}
/* SARIM: the call-center catalogue and the flow catalogue tell the same flow the same way */
for (const s of SARIM_FLOWS) {
  const f = FLOWS.find((x) => x.id === s.id);
  if (!f) continue;
  check(f.name === s.name && f.trigger === s.trigger && f.perMonth === s.perMonth && f.version === s.version, `flusso ${s.id}: nome, avvio, volume o versione diversi fra flussi SARIM e catalogo dei flussi`);
  const facts = FLOW_FACTS[s.id];
  if (facts) check(facts.errors === s.errors, `errori a 30 giorni di ${s.id}: la pagina del flusso dice ${facts.errors}, la panoramica SARIM ${s.errors}`);
}
/* the PEC types of the sector package add up to the PEC flow's month */
const pec = FLOWS.find((f) => f.id === "pec");
const types = SECTOR_PACKAGES.find((p) => p.id === "bonifica")?.caseTypes ?? [];
const typesSum = types.reduce((n, t) => n + (t.perMonth ?? 0), 0);
check(!!pec && typesSum === pec.perMonth, `pacchetto di settore: i tipi di PEC fanno ${typesSum} al mese, il flusso PEC ${pec?.perMonth}`);

/* ---- Board: every card leads somewhere that exists ---- */
const SETTINGS_SECTIONS = ["generale", "settore", "avvio", "persone", "squadra", "struttura", "condivisioni", "sicurezza", "dove-gira", "anonimizzazione", "conformita", "registro", "aspetto", "prodotto"];
for (const t of BOARD_TASKS) {
  const g = t.target;
  if (g.kind === "flowTest") check(FLOWS.some((f) => f.id === g.flow), `Board, card ${t.id}: il flusso ${g.flow} non esiste`);
  if (g.kind === "sarimFlow") check(SARIM_FLOWS.some((f) => f.id === g.flow), `Board, card ${t.id}: il flusso SARIM ${g.flow} non esiste`);
  if (g.kind === "caseKind") check(CASES.some((c) => c.kind === g.caseKind), `Board, card ${t.id}: nessuna pratica di tipo ${g.caseKind}`);
  if (g.kind === "settings") check(SETTINGS_SECTIONS.includes(g.section), `Board, card ${t.id}: la sezione ${g.section} delle impostazioni non esiste`);
  if (g.kind === "procedure") check(PROCEDURE_IDS.has(g.id), `Board, card ${t.id}: la procedura ${g.id} non esiste in Conoscenza`);
}

/* ---- the SARIM edition (sarim.html): cards, flows, contracts ---- */
checkSarimCards(check);
checkSarimContracts(check);

/* ---- queue ---- */
const queue = CASES.filter((c) => c.org === "nocera" && c.status === "da-confermare");
check(queue.length > 0, "la coda di Da fare è vuota all'inizio");

console.log(`${checks} controlli, ${problems.length} problemi`);
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error("ui-fixtures-check: FAIL");
  process.exit(1);
}
console.log("ui-fixtures-check: ok, i numeri tornano");
