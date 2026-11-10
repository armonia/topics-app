/**
 * The ORBIT edition's contracts agree with themselves and with the rest of its world
 * (called by `scripts/ui-fixtures-check.ts`).
 *
 * What it pins: the 13 contracts and their cards; the public facts of the seven
 * real ones (value, CIG, dates, counterparty), written here by hand so a typo in
 * the fixture fails; clause ids stable across versions; every obligation quoting
 * its clause verbatim; notice dates computed from the end date; comments,
 * variants and attachments pointing at versions that exist; nothing dated after
 * the demo moment; and the word-level diff the version comparison is drawn from.
 */
import { ORBIT_CONTRACTS } from "../../client/src/ui/fixtures/orbit-org/contracts";
import { ORBIT_CARDS } from "../../client/src/ui/fixtures/orbit-org/cards";
import { ORBIT_OPS_FLOWS } from "../../client/src/ui/fixtures/orbit-org/flows";
import { ORBIT_AGENTS, ORBIT_PERSONAS } from "../../client/src/ui/fixtures/orbit-org/people";
import type { Contract, ContractKind } from "../../client/src/ui/fixtures/orbit-org/types";
import { DEMO_NOW, DEMO_TODAY } from "../../client/src/ui/fixtures/org/clock";
import {
  compareVersions, contractAlerts, formatMoney, noticeDate, variantShare, versionOf, wordDiff,
} from "../../client/src/ui-gallery/orbit/model/contracts";

export type Check = (ok: boolean, msg: string) => void;

/** The contracts and, for each, exactly the cards it is linked to. */
const EXPECTED_CARDS: Record<string, string[]> = {
  "c-castellabate": ["CT-V07"],
  "c-albanella": ["CT-F01"],
  "c-rocca-priora": [],
  "c-agropoli": [],
  "c-sarno": [],
  "c-smart-leaf": ["SG-F10"],
  "c-vallo": ["CT-S02"],
  "c-sub-lavaggio": ["CT-N12"],
  "c-carburante": ["CT-R03", "FT-2611"],
  "c-officina": ["FT-2604"],
  "c-td-castellabate": ["PE-118"],
  "c-accordo-castellabate": ["CT-T04"],
  "c-accordo-turni": ["CT-A05"],
};

/** The public facts of the real contracts (TED, ARERA portal, orbitambiente.it), copied by hand. */
const PUBLIC_FACTS: Record<string, { counterparty: string; value: number; cig?: string; start: string; end: string; signed?: [number, string] }> = {
  "c-castellabate": { counterparty: "Comune di Castellabate", value: 11375268.92, cig: "B8B7C39D2A", start: "2026-04-01", end: "2030-03-31", signed: [2, "2026-01-29"] },
  "c-albanella": { counterparty: "Comune di Albanella", value: 7559582.25, cig: "B6242F1551", start: "2026-01-01", end: "2032-12-31" },
  "c-rocca-priora": { counterparty: "Comune di Rocca Priora", value: 13947325.33, start: "2022-11-02", end: "2030-11-01", signed: [1, "2022-11-02"] },
  "c-agropoli": { counterparty: "Comune di Agropoli", value: 18061509.16, start: "2022-10-01", end: "2027-09-30" },
  "c-sarno": { counterparty: "Comune di Sarno", value: 18840049.16, start: "2022-09-30", end: "", signed: [1, "2022-09-30"] },
  "c-smart-leaf": { counterparty: "AMA S.p.A.", value: 96855274.52, start: "2024-10-01", end: "" },
  "c-vallo": { counterparty: "Comune di Vallo della Lucania", value: 9298979.61, start: "2017-12-05", end: "2025-03-14", signed: [1, "2017-12-05"] },
};

/** Who owns a contract, by kind. */
const OWNER_BY_KIND: Record<ContractKind, string> = {
  servizio: "orbit-bruno", appalto: "orbit-bruno", subappalto: "orbit-bruno",
  fornitura: "orbit-contabilita", personale: "orbit-personale", sindacale: "orbit-personale",
};

/** The clauses each multi-version contract changes between two versions, and nothing else. */
const EXPECTED_CHANGES: Array<[string, number, number, string[]]> = [
  ["c-castellabate", 2, 3, ["art-4", "art-9", "art-12"]],
  ["c-castellabate", 1, 2, ["art-2", "art-9", "art-12"]],
  ["c-albanella", 1, 2, ["art-2", "art-7"]],
  ["c-agropoli", 1, 2, ["art-6"]],
  ["c-carburante", 1, 2, ["art-5", "art-7"]],
  ["c-accordo-turni", 1, 2, ["art-3", "art-5"]],
];

/** Flows a contract may link to (the eight of the ORBIT edition). */
const FLOW_IDS = ["orbit-segnalazioni", "orbit-foglie", "orbit-fir", "orbit-fatture", "orbit-gara", "orbit-scadenze", "orbit-turni", "orbit-varianti"];

/** The kinds whose value is written in the contract text (for personnel and union agreements it is an estimate of the cost). */
const COMMERCIAL: ContractKind[] = ["servizio", "appalto", "subappalto", "fornitura"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/;
const NOW = Date.parse(DEMO_NOW);
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function checkOrbitContracts(check: Check): void {
  const personas = new Set(ORBIT_PERSONAS.map((p) => p.id));
  const agents = new Set(ORBIT_AGENTS.map((a) => `agent:${a.id}`));
  const cardIds = new Set(ORBIT_CARDS.map((c) => c.id));
  const flowIds = new Set(ORBIT_OPS_FLOWS.length ? ORBIT_OPS_FLOWS.map((f) => f.id) : FLOW_IDS);

  const ids = ORBIT_CONTRACTS.map((c) => c.id);
  check(new Set(ids).size === ids.length, `contratti ORBIT: id ripetuti (${ids.join(", ")})`);
  check(sameList([...ids].sort(), Object.keys(EXPECTED_CARDS).sort()), `contratti ORBIT: attesi ${Object.keys(EXPECTED_CARDS).join(", ")}, trovati ${ids.join(", ")}`);

  const stamp = (where: string, at: string | undefined) => {
    check(!!at && STAMP.test(at), `${where}: data e ora «${at}» non in forma ISO con fuso`);
    if (at) check(Date.parse(at) <= NOW, `${where}: ${at} è dopo il momento della demo (${DEMO_NOW})`);
  };

  const obligationIds = new Set<string>();
  let overdue = 0;
  for (const c of ORBIT_CONTRACTS) checkContract(c);
  check(overdue >= 1 && overdue <= 2, `contratti ORBIT: gli obblighi in ritardo devono essere 1 o 2, sono ${overdue}`);

  function checkContract(c: Contract) {
    const at = `contratto ${c.id}`;
    check(Number.isFinite(c.value) && c.value > 0, `${at}: valore ${c.value} non positivo`);
    check(DAY.test(c.start), `${at}: inizio «${c.start}» non è un giorno`);
    check(c.end === "" || DAY.test(c.end), `${at}: fine «${c.end}» non è un giorno`);
    if (c.end) check(c.start <= c.end, `${at}: inizio ${c.start} dopo la fine ${c.end}`);
    check((c.end !== "" && c.end < DEMO_TODAY) === (c.status === "scaduto"), `${at}: stato «${c.status}» e fine ${c.end || "(nessuna)"} non coincidono con oggi ${DEMO_TODAY}`);
    check(c.renewal.kind === "nessuno" ? c.renewal.noticeDays === 0 && c.renewal.months === 0 : c.renewal.months > 0 && c.renewal.noticeDays > 0, `${at}: rinnovo ${c.renewal.kind} con ${c.renewal.months} mesi e ${c.renewal.noticeDays} giorni di preavviso`);
    check(c.renewal.kind === "nessuno" || c.end !== "", `${at}: rinnovo ${c.renewal.kind} senza data di fine`);
    check(c.owner === OWNER_BY_KIND[c.kind], `${at}: responsabile ${c.owner}, per un contratto di tipo ${c.kind} deve essere ${OWNER_BY_KIND[c.kind]}`);
    check(ORBIT_PERSONAS.find((p) => p.id === c.owner)?.area === c.area, `${at}: area ${c.area} diversa da quella del responsabile ${c.owner}`);

    const fact = PUBLIC_FACTS[c.id];
    if (fact) {
      check(c.value === fact.value, `${at}: valore ${c.value}, il dato pubblico è ${fact.value}`);
      check(c.cig === fact.cig, `${at}: CIG ${c.cig ?? "(nessuno)"}, il dato pubblico è ${fact.cig ?? "(nessuno)"}`);
      check(c.start === fact.start && c.end === fact.end, `${at}: date ${c.start}..${c.end || "(nessuna)"}, i dati pubblici dicono ${fact.start}..${fact.end || "(nessuna)"}`);
      check(c.counterparty === fact.counterparty, `${at}: controparte «${c.counterparty}», il dato pubblico è «${fact.counterparty}»`);
      check(c.valuePeriod === "totale", `${at}: il valore pubblico è totale, non per ${c.valuePeriod}`);
      if (fact.signed) {
        const [n, day] = fact.signed;
        const v = versionOf(c, n);
        check(!!v?.signed && v.at.slice(0, 10) === day, `${at}: la versione ${n} deve essere firmata il ${day}`);
      }
    } else {
      check(c.cig === undefined, `${at}: un contratto di esempio non porta un CIG`);
      check(/\(esempio\)$/.test(c.counterparty), `${at}: la controparte di esempio «${c.counterparty}» deve finire con «(esempio)»`);
    }

    // links
    check(sameList(c.links.cards, EXPECTED_CARDS[c.id] ?? []), `${at}: card collegate ${c.links.cards.join(", ") || "(nessuna)"}, attese ${(EXPECTED_CARDS[c.id] ?? []).join(", ") || "(nessuna)"}`);
    if (ORBIT_CARDS.length) for (const id of c.links.cards) check(cardIds.has(id), `${at}: la card ${id} non esiste`);
    for (const f of c.links.flows) check(flowIds.has(f), `${at}: il flusso ${f} non esiste`);

    // versions and clauses
    const numbers = c.versions.map((v) => v.n);
    check(sameList(numbers.map(String), numbers.map((_, i) => String(i + 1))), `${at}: versioni ${numbers.join(", ")}, attese 1..${numbers.length}`);
    check(c.versions.length >= 1 && c.versions.length <= 3, `${at}: ${c.versions.length} versioni, attese da 1 a 3`);
    for (const v of c.versions) {
      const where = `${at}, versione ${v.n}`;
      check(personas.has(v.author) || agents.has(v.author), `${where}: autore ${v.author} sconosciuto`);
      if (v.draftedBy) check(agents.has(v.draftedBy), `${where}: bozza di ${v.draftedBy}, che non è un agente`);
      stamp(where, v.at);
      check(v.clauses.length >= 6 && v.clauses.length <= 12, `${where}: ${v.clauses.length} clausole, attese da 6 a 12`);
      const clauseIds = v.clauses.map((k) => k.id);
      check(new Set(clauseIds).size === clauseIds.length, `${where}: clausole ripetute (${clauseIds.join(", ")})`);
      for (const k of v.clauses) {
        check(k.id === `art-${k.n}`, `${where}: la clausola ${k.id} ha il numero ${k.n}`);
        check(k.title.trim() !== "" && k.text.trim() !== "", `${where}: la clausola ${k.id} è vuota`);
      }
      if (v.value !== undefined && COMMERCIAL.includes(c.kind)) check(v.clauses.some((k) => k.text.includes(`euro ${formatMoney(v.value as number)}`)), `${where}: il valore ${formatMoney(v.value)} non è scritto in nessuna clausola`);
      if (v.signed) check(c.attachments.some((a) => a.kind === "firmato" && a.version === v.n), `${where}: firmata ma senza copia firmata negli allegati`);
    }
    const reference = c.versions.find((v) => v.signed) ?? c.versions[0];
    if (COMMERCIAL.includes(c.kind) && reference) {
      check(reference.clauses.some((k) => k.text.includes(`euro ${formatMoney(c.value)}`)), `${at}: il valore ${formatMoney(c.value)} non è scritto nel testo della versione ${reference.n}`);
    }
    for (const [id, from, to, changed] of EXPECTED_CHANGES) {
      if (id !== c.id) continue;
      const got = compareVersions(c, from, to).filter((r) => r.status !== "same").map((r) => r.clauseId);
      check(sameList(got, changed), `${at}: dalla versione ${from} alla ${to} cambiano ${got.join(", ") || "(niente)"}, attese ${changed.join(", ")}`);
    }

    // obligations
    check(c.obligations.length >= 3 && c.obligations.length <= 7, `${at}: ${c.obligations.length} obblighi, attesi da 3 a 7`);
    const notice = noticeDate(c);
    const renewals = c.obligations.filter((o) => o.kind === "rinnovo");
    check(renewals.length === (notice ? 1 : 0), `${at}: ${renewals.length} obblighi di rinnovo, atteso ${notice ? 1 : 0}`);
    for (const o of c.obligations) {
      const where = `${at}, obbligo ${o.id}`;
      check(!obligationIds.has(o.id), `${where}: id ripetuto`);
      obligationIds.add(o.id);
      const text = versionOf(c, o.version)?.clauses.find((k) => k.id === o.clause)?.text;
      check(text !== undefined, `${where}: la clausola ${o.clause} non esiste nella versione ${o.version}`);
      check(o.quote.trim() !== "" && !!text?.includes(o.quote), `${where}: la citazione «${o.quote}» non è nel testo di ${o.clause}, versione ${o.version}`);
      check(personas.has(o.owner), `${where}: responsabile ${o.owner} sconosciuto`);
      if (o.due !== undefined) check(DAY.test(o.due), `${where}: scadenza «${o.due}» non è un giorno`);
      if (o.kind === "rinnovo") check(o.due === notice, `${where}: scadenza ${o.due}, il preavviso calcolato dalla fine è ${notice}`);
      if (o.kind === "ricorrente") check(!!o.every, `${where}: ricorrente senza «every»`);
      if (o.due && o.due < DEMO_TODAY && !o.done) overdue++;
    }

    // comments
    for (const m of c.comments) {
      const where = `${at}, commento ${m.id}`;
      check(!!versionOf(c, m.version)?.clauses.some((k) => k.id === m.clause), `${where}: la clausola ${m.clause} non esiste nella versione ${m.version}`);
      check(personas.has(m.author), `${where}: autore ${m.author} sconosciuto`);
      stamp(where, m.at);
      for (const r of m.replies ?? []) {
        check(personas.has(r.author), `${where}: risposta di ${r.author}, sconosciuto`);
        stamp(`${where}, risposta`, r.at);
        check(r.at > m.at, `${where}: risposta del ${r.at} prima del commento`);
      }
    }

    // attachments
    const attachmentIds = c.attachments.map((a) => a.id);
    check(new Set(attachmentIds).size === attachmentIds.length, `${at}: allegati ripetuti`);
    for (const a of c.attachments) {
      const where = `${at}, allegato ${a.id}`;
      if (a.version !== undefined) check(!!versionOf(c, a.version), `${where}: la versione ${a.version} non esiste`);
      check(a.lines.length > 0, `${where}: senza testo`);
      stamp(where, a.at);
    }

    // variants
    for (const v of c.variants) {
      const where = `${at}, variante ${v.id}`;
      const version = versionOf(c, v.version);
      check(!!version, `${where}: la versione ${v.version} non esiste`);
      if (v.status === "in-corso") {
        check(!version?.signed, `${where}: in corso ma la versione ${v.version} è firmata`);
        check(!!v.card && c.links.cards.includes(v.card), `${where}: in corso senza una card collegata al contratto`);
      }
      if (v.status === "firmata") check(!!version?.signed, `${where}: firmata ma la versione ${v.version} non lo è`);
      stamp(where, v.at);
    }

    // approvals: the chain of the version being worked on, or of the one in force
    check(c.approvals.length >= 3 && c.approvals.length <= 5, `${at}: ${c.approvals.length} passi di approvazione, attesi da 3 a 5`);
    const stepIds = c.approvals.map((s) => s.id);
    check(new Set(stepIds).size === stepIds.length, `${at}: passi di approvazione ripetuti`);
    const open = c.versions.some((v) => !v.signed && v.n === Math.max(...numbers));
    const allDone = c.approvals.every((s) => s.state === "fatto");
    check(open ? !allDone : allDone, open ? `${at}: l'ultima versione non è firmata ma la catena è tutta fatta` : `${at}: l'ultima versione è firmata ma la catena ha passi aperti`);
    for (const s of c.approvals) {
      check(personas.has(s.who), `${at}, passo ${s.id}: ${s.who} sconosciuto`);
      if (s.state === "fatto") stamp(`${at}, passo ${s.id}`, s.at);
      else check(s.at === undefined, `${at}, passo ${s.id}: non fatto ma con una data`);
    }

    // the alerts must be computable for every contract
    check(Array.isArray(contractAlerts(c)), `${at}: avvisi non calcolabili`);
  }

  // the screen's own facts
  const principal = ORBIT_CONTRACTS.find((c) => c.id === "c-castellabate");
  if (principal) {
    check(Math.round(variantShare(principal, 3) * 10) / 10 === 4.2, `c-castellabate: la variante vale ${variantShare(principal, 3).toFixed(2)}% del valore iniziale, attesa 4,2%`);
    const v3 = versionOf(principal, 3);
    check(principal.comments.some((m) => m.clause === "art-9" && m.version === 3 && !!v3 && m.at < v3.at), "c-castellabate: manca il commento all'art. 9 scritto prima dell'ultima modifica della versione 3");
  }
  const sub = ORBIT_CONTRACTS.find((c) => c.id === "c-sub-lavaggio");
  check(!!sub?.tags?.includes("figlio di c-castellabate") && !!principal?.versions.some((v) => v.clauses.some((k) => k.id === "art-11")), "c-sub-lavaggio: deve dirsi figlio di c-castellabate, che deve avere l'art. 11 sul subappalto");

  // cards that cite a contract cite a clause it has
  for (const card of ORBIT_CARDS) {
    const link = card.links;
    if (!link?.contract) continue;
    const contract = ORBIT_CONTRACTS.find((c) => c.id === link.contract);
    check(!!contract, `card ${card.id}: il contratto ${link.contract} non esiste`);
    if (contract && link.clause) check(contract.versions.some((v) => v.clauses.some((k) => k.id === link.clause)), `card ${card.id}: la clausola ${link.clause} non esiste in ${contract.id}`);
  }

  // the word diff the comparison is drawn from
  const samples: Array<[string, string, string[]]> = [
    ["i passaggi sono sei a settimana", "i passaggi sono sette a settimana", ["same:i passaggi sono", "removed:sei", "added:sette", "same:a settimana"]],
    ["euro 25, oltre alla maggiorazione", "euro 32, oltre alla maggiorazione", ["same:euro", "removed:25,", "added:32,", "same:oltre alla maggiorazione"]],
    ["a b c", "a c", ["same:a", "removed:b", "same:c"]],
    ["a c", "a b c", ["same:a", "added:b", "same:c"]],
  ];
  for (const [a, b, want] of samples) {
    const got = wordDiff(a, b).map((p) => `${p.kind}:${p.text}`);
    check(sameList(got, want), `wordDiff(«${a}», «${b}»): ${got.join(" | ")}, atteso ${want.join(" | ")}`);
  }
  const pairs = ORBIT_CONTRACTS.flatMap((c) => c.versions.flatMap((v) => c.versions.filter((w) => w.n > v.n).flatMap((w) =>
    v.clauses.flatMap((k) => { const other = w.clauses.find((x) => x.id === k.id); return other ? [[k.text, other.text] as const] : []; }))));
  for (const [a, b] of [...pairs, ["", "una parola"] as const, ["una parola", ""] as const]) {
    const same = wordDiff(a, a);
    check(same.every((p) => p.kind === "same"), `wordDiff: un testo confrontato con se stesso ha parti aggiunte o tolte («${a.slice(0, 40)}»)`);
    const parts = wordDiff(a, b);
    const toB = parts.filter((p) => p.kind !== "removed").flatMap((p) => tokens(p.text));
    const toA = parts.filter((p) => p.kind !== "added").flatMap((p) => tokens(p.text));
    check(sameList(toB, tokens(b)), `wordDiff: uguali più aggiunte non rifanno il testo nuovo («${b.slice(0, 40)}»)`);
    check(sameList(toA, tokens(a)), `wordDiff: uguali più tolte non rifanno il testo vecchio («${a.slice(0, 40)}»)`);
    for (let i = 1; i < parts.length; i++) check(parts[i].kind !== parts[i - 1].kind, "wordDiff: due parti vicine dello stesso tipo non unite");
  }
}
