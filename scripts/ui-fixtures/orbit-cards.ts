/**
 * The ORBIT edition's cards agree with themselves and with the rest of its world
 * (called by `scripts/ui-fixtures-check.ts`).
 *
 *  · every card names a flow that exists and a step of that flow whose column
 *    is the column the card stands in;
 *  · its history starts in the first column, never goes back in time and never
 *    passes the demo moment; a closed card was closed in the last seven days;
 *  · who works on it is a person or an agent, who checks it is a person;
 *  · every value the agent read quotes words that are really on the original it
 *    names, and invoice totals add up (taxable + 22% VAT = total);
 *  · every flow has at least one card, every column holds a card somewhere,
 *    ids are unique, and a link points at a card and a contract (and clause)
 *    that exist. (A flow may leave a column empty: the groups that once
 *    guaranteed a card in every column no longer exist.)
 */
import { ORBIT_CARDS, ORBIT_STAGES } from "../../client/src/ui/fixtures/orbit-org/cards";
import { ORBIT_OPS_FLOWS } from "../../client/src/ui/fixtures/orbit-org/flows";
import { ORBIT_CONTRACTS } from "../../client/src/ui/fixtures/orbit-org/contracts";
import { ORBIT_AGENTS, ORBIT_PERSONAS } from "../../client/src/ui/fixtures/orbit-org/people";
import { DEMO_NOW } from "../../client/src/ui/fixtures/org/clock";

export type Check = (ok: boolean, msg: string) => void;

/** The contract ids the cards may link to until `contracts.ts` holds the contracts themselves. */
const PLANNED_CONTRACTS = [
  "c-castellabate", "c-albanella", "c-rocca-priora", "c-agropoli", "c-sarno", "c-smart-leaf", "c-vallo",
  "c-sub-lavaggio", "c-carburante", "c-officina", "c-td-castellabate", "c-accordo-castellabate", "c-accordo-turni",
];

/** A week before the demo moment: the oldest a card in the last column may have been closed. */
const DONE_FROM = "2026-10-30T00:00:00+01:00";
const VAT = 0.22;

const time = (iso: string) => Date.parse(iso);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** `25.416,00 euro` → 25416 (Italian thousands dot, decimal comma). */
const amount = (s: string) => Number(s.replace(/[^\d,.]/g, "").replace(/\./g, "").replace(",", "."));

export function checkOrbitCards(check: Check): void {
  const now = time(DEMO_NOW);
  const personas = new Set(ORBIT_PERSONAS.map((p) => p.id));
  const agents = new Set(ORBIT_AGENTS.map((a) => a.id));
  const flows = new Map(ORBIT_OPS_FLOWS.map((f) => [f.id, f]));
  const cardIds = new Set(ORBIT_CARDS.map((c) => c.id));
  const stages = ORBIT_STAGES.map((s) => s.id);
  const first = stages[0];
  const last = stages[stages.length - 1];
  const contracts = ORBIT_CONTRACTS.length ? new Map(ORBIT_CONTRACTS.map((c) => [c.id, c])) : undefined;
  const contractIds = new Set(contracts ? contracts.keys() : PLANNED_CONTRACTS);
  const actorExists = (by: string) => (by.startsWith("agent:") ? agents.has(by.slice(6)) : personas.has(by));

  /* ---- flows ---- */
  for (const f of ORBIT_OPS_FLOWS) {
    for (const s of f.steps) {
      if (s.actor.kind === "agent") check(agents.has(s.actor.id), `ORBIT, flusso ${f.id} passo ${s.id}: l'agente ${s.actor.id} non esiste`);
      if (s.actor.kind === "person") check(personas.has(s.actor.id), `ORBIT, flusso ${f.id} passo ${s.id}: la persona ${s.actor.id} non esiste`);
    }
    check(new Set(f.steps.map((s) => s.id)).size === f.steps.length, `ORBIT, flusso ${f.id}: due passi con lo stesso id`);
  }
  for (const f of ORBIT_OPS_FLOWS) {
    check(agents.has(f.agent), `ORBIT, flusso ${f.id}: l'agente ${f.agent} non esiste`);
    check(f.stuckAfterHours > 0, `ORBIT, flusso ${f.id}: il tempo oltre cui una card è ferma (${f.stuckAfterHours} ore) non è positivo`);
    check(f.source.trim().length > 0, `ORBIT, flusso ${f.id}: manca da dove entra`);
  }

  /* ---- cards ---- */
  check(cardIds.size === ORBIT_CARDS.length, `ORBIT: ${ORBIT_CARDS.length} card ma ${cardIds.size} id diversi`);
  for (const c of ORBIT_CARDS) {
    const where = `ORBIT, card ${c.id}`;
    const flow = flows.get(c.flow);
    check(!!flow, `${where}: il flusso ${c.flow} non esiste`);

    /* history */
    const h = c.history;
    check(h.length > 0, `${where}: la storia è vuota`);
    const column = h[h.length - 1]?.stage;
    if (h.length) check(h[0].stage === first, `${where}: la storia comincia da «${h[0].stage}», non da «${first}»`);
    h.forEach((e, i) => {
      check(!Number.isNaN(time(e.at)), `${where}: la data «${e.at}» della storia non si legge`);
      check(time(e.at) <= now, `${where}: entra in «${e.stage}» il ${e.at}, dopo il momento della demo`);
      if (i > 0) check(time(e.at) >= time(h[i - 1].at), `${where}: la storia torna indietro nel tempo (${h[i - 1].at} poi ${e.at})`);
      check(actorExists(e.by), `${where}: «${e.by}» ha spostato la card in «${e.stage}» ma non è né una persona né un agente`);
    });
    if (column === last) {
      const closed = time(h[h.length - 1].at);
      check(closed >= time(DONE_FROM) && closed <= now, `${where}: è in «${last}» ma è stata chiusa il ${h[h.length - 1].at}, fuori dagli ultimi 7 giorni`);
    }

    /* step */
    const step = flow?.steps.find((s) => s.id === c.step);
    if (flow) check(!!step, `${where}: il passo ${c.step} non è nel flusso ${c.flow}`);
    if (step && column) check(step.stage === column, `${where}: sta in «${column}» ma il passo ${c.step} di ${c.flow} sta in «${step.stage}»`);

    /* people */
    const w = c.worker;
    check(w.kind === "agent" ? agents.has(w.id) : personas.has(w.id), `${where}: chi la lavora (${w.kind} ${w.id}) non esiste`);
    check(time(w.since) <= now, `${where}: chi la lavora ha cominciato il ${w.since}, dopo il momento della demo`);
    check(personas.has(c.reviewer), `${where}: chi la verifica (${c.reviewer}) non è una persona di ORBIT`);
    if (c.blocked) check(time(c.blocked.since) <= now, `${where}: ferma dal ${c.blocked.since}, dopo il momento della demo`);
    if (c.due) check(/^\d{4}-\d{2}-\d{2}$/.test(c.due), `${where}: la scadenza «${c.due}» non è un giorno AAAA-MM-GG`);

    /* originals and values */
    check(c.originals.length > 0, `${where}: nessun originale`);
    check(new Set(c.originals.map((o) => o.id)).size === c.originals.length, `${where}: due originali con lo stesso id`);
    for (const o of c.originals) check(time(o.at) <= now, `${where}: l'originale ${o.id} è arrivato il ${o.at}, dopo il momento della demo`);
    for (const v of c.values) {
      const doc = c.originals.find((o) => o.id === v.doc);
      check(!!doc, `${where}, valore «${v.label}»: l'originale ${v.doc} non è fra quelli della card`);
      if (doc) check(doc.lines.some((l) => norm(l).includes(norm(v.quote))), `${where}, valore «${v.label}»: «${v.quote}» non è nel testo di ${v.doc}`);
      check(v.confidence >= 0 && v.confidence <= 100, `${where}, valore «${v.label}»: sicurezza ${v.confidence} fuori da 0-100`);
    }
    const byLabel = (label: string) => {
      const v = c.values.find((x) => x.label === label);
      return v ? amount(v.value) : undefined;
    };
    const net = byLabel("Imponibile");
    const vat = byLabel("IVA");
    const total = byLabel("Totale");
    if (net !== undefined && vat !== undefined) check(Math.abs(net * VAT - vat) < 0.011, `${where}: IVA ${vat} non è il 22% di ${net}`);
    if (net !== undefined && vat !== undefined && total !== undefined) check(Math.abs(net + vat - total) < 0.011, `${where}: ${net} + ${vat} non fa ${total}`);

    /* links */
    const link = c.links;
    if (link?.card) check(cardIds.has(link.card) && link.card !== c.id, `${where}: collegata alla card ${link.card}, che non esiste`);
    if (link?.contract) {
      check(contractIds.has(link.contract), `${where}: collegata al contratto ${link.contract}, che non esiste`);
      const contract = contracts?.get(link.contract);
      if (contract && link.clause) {
        const clause = link.clause;
        check(contract.versions.some((v) => v.clauses.some((cl) => cl.id === clause)), `${where}: cita la clausola ${clause}, che non è in nessuna versione di ${link.contract}`);
      }
    }
    if (link?.clause) check(!!link.contract, `${where}: cita la clausola ${link.clause} senza il contratto`);
  }

  /* ---- every flow has work, and every column holds some ---- */
  for (const f of ORBIT_OPS_FLOWS) {
    check(ORBIT_CARDS.some((c) => c.flow === f.id), `ORBIT, flusso ${f.id}: nessuna card`);
  }
  for (const s of stages) {
    const n = ORBIT_CARDS.filter((c) => c.history[c.history.length - 1]?.stage === s).length;
    check(n > 0, `ORBIT: nessuna card in «${s}»`);
  }
}
