/**
 * The contracts of the SARIM edition as every screen reads them: the version
 * in force, the word-level difference between two versions, the notice date
 * computed from the end date, the value a variant sets, and the alerts that
 * the dates, the obligations and the open cards raise.
 *
 * Pure functions over the fixtures: no React, no state, no clock but the demo
 * one. A date printed on the list, on the contract page and in the calendar
 * comes from the same function, so the three cannot disagree.
 */
import type { ApprovalStep, Clause, Contract, ContractKind, ContractStatus, ContractVersion, Obligation, SarimCard } from '../../../ui/fixtures/sarim-org/types';
import { personaById, world } from '../world';
import { DEMO_TODAY, addDays, parseDay } from '../../../ui/fixtures/org/clock';
import { stageOf } from './live';

/* ---------- lookups ---------- */

export function versionOf(contract: Contract, n: number): ContractVersion | undefined {
  return contract.versions.find((v) => v.n === n);
}

/** The highest version, signed or not (the one being worked on). */
export function latestVersion(contract: Contract): ContractVersion {
  return contract.versions.reduce((a, b) => (b.n > a.n ? b : a));
}

/** The version in force: the highest signed one, or the highest when none is signed yet. */
export function currentVersion(contract: Contract): ContractVersion {
  const signed = contract.versions.filter((v) => v.signed);
  return signed.length ? signed.reduce((a, b) => (b.n > a.n ? b : a)) : latestVersion(contract);
}

export function clauseIn(version: ContractVersion | undefined, clauseId: string): Clause | undefined {
  return version?.clauses.find((c) => c.id === clauseId);
}

/* ---------- word-level difference ---------- */

export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  /** One or more words, separated by single spaces; parts are shown separated by a space too. */
  text: string;
}

/** Words split on whitespace; punctuation stays attached, so «agosto.» and «agosto,» are different words. (allow-italian: quotes the clause text) */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The difference between two texts, word by word: the longest common
 * subsequence of their words is kept as `same`, the rest of `a` is `removed`
 * and the rest of `b` is `added`. In a replaced stretch the removed words come
 * first. Consecutive words of the same kind are merged into one part.
 */
export function wordDiff(a: string, b: string): DiffPart[] {
  const x = words(a);
  const y = words(b);
  const width = y.length + 1;
  // common[i * width + j] = length of the longest common subsequence of x[i..] and y[j..]
  const common = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      common[i * width + j] = x[i] === y[j]
        ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], word: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += ` ${word}`;
    else parts.push({ kind, text: word });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push('same', x[i]);
      i++;
      j++;
    } else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
      push('removed', x[i]);
      i++;
    } else {
      push('added', y[j]);
      j++;
    }
  }
  for (; i < x.length; i++) push('removed', x[i]);
  for (; j < y.length; j++) push('added', y[j]);
  return parts;
}

export interface ClauseComparison {
  clauseId: string;
  n: string;
  title: string;
  status: 'same' | 'changed' | 'added' | 'removed';
  parts: DiffPart[];
}

/**
 * Two versions side by side, clause by clause in the order of `to`; a clause
 * only `from` has is placed after the clause it followed there.
 */
export function compareVersions(contract: Contract, from: number, to: number): ClauseComparison[] {
  const a = versionOf(contract, from);
  const b = versionOf(contract, to);
  if (!a || !b) return [];
  const ids = b.clauses.map((c) => c.id);
  a.clauses.forEach((c, k) => {
    if (ids.includes(c.id)) return;
    const before = a.clauses.slice(0, k).reverse().find((p) => ids.includes(p.id));
    ids.splice(before ? ids.indexOf(before.id) + 1 : 0, 0, c.id);
  });
  return ids.map((id): ClauseComparison => {
    const old = clauseIn(a, id);
    const now = clauseIn(b, id);
    if (old && now) {
      const same = old.text === now.text && old.title === now.title;
      return { clauseId: id, n: now.n, title: now.title, status: same ? 'same' : 'changed', parts: same ? [{ kind: 'same', text: now.text }] : wordDiff(old.text, now.text) };
    }
    if (now) return { clauseId: id, n: now.n, title: now.title, status: 'added', parts: [{ kind: 'added', text: now.text }] };
    const gone = old as Clause;
    return { clauseId: id, n: gone.n, title: gone.title, status: 'removed', parts: [{ kind: 'removed', text: gone.text }] };
  });
}

/* ---------- dates and values ---------- */

/** The last day to give notice (end minus `renewal.noticeDays`); none without an end date or a renewal. */
export function noticeDate(contract: Contract): string | undefined {
  if (!contract.end || contract.renewal.kind === 'nessuno') return undefined; // allow-italian: values compared by value
  return addDays(contract.end, -contract.renewal.noticeDays);
}

/** Days from `today` to `day`: positive in the future, negative in the past. */
export function daysTo(day: string, today: string = DEMO_TODAY): number {
  return Math.round((parseDay(day).getTime() - parseDay(today).getTime()) / 86_400_000);
}

/** `06/11` in the year of `today`, `04/07/2032` otherwise. */
export function dayLabel(day: string, today: string = DEMO_TODAY): string {
  const [y, m, d] = day.split('-');
  return y === today.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** Euro as the contracts print them: `11.375.268,92`. */
export function formatMoney(value: number): string {
  const [whole, cents] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

/** A percentage with one decimal and its sign: `+4,2%`. */
export function formatShare(share: number): string {
  const rounded = Math.round(share * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1).replace('.', ',')}%`;
}

/** The value a version sets: the last `value` up to it, or the contract's initial value. */
export function versionValue(contract: Contract, n: number): number {
  let value = contract.value;
  for (const v of [...contract.versions].sort((p, q) => p.n - q.n)) {
    if (v.n > n) break;
    if (v.value !== undefined) value = v.value;
  }
  return value;
}

/** The value in force (the one of the version in force). */
export function currentValue(contract: Contract): number {
  return versionValue(contract, currentVersion(contract).n);
}

/** How much a version changes the value, in percent of the first signed version (or of the first one). */
export function variantShare(contract: Contract, version: number): number {
  const ordered = [...contract.versions].sort((p, q) => p.n - q.n);
  const first = ordered.find((v) => v.signed) ?? ordered[0];
  const base = versionValue(contract, first.n);
  return base ? ((versionValue(contract, version) - base) / base) * 100 : 0;
}

/* ---------- labels ---------- */

export const statusLabel: Record<ContractStatus, string> = {
  bozza: 'Bozza', // allow-italian: fixture data, shown as written
  revisione: 'In verifica', // allow-italian: fixture data, shown as written
  approvazione: 'Da approvare', // allow-italian: fixture data, shown as written
  firma: 'Alla firma', // allow-italian: fixture data, shown as written
  attivo: 'In vigore', // allow-italian: fixture data, shown as written
  rinnovo: 'In rinnovo', // allow-italian: fixture data, shown as written
  scaduto: 'Scaduto', // allow-italian: fixture data, shown as written
};

export const kindLabel: Record<ContractKind, string> = {
  servizio: 'Servizio', // allow-italian: fixture data, shown as written
  appalto: 'Appalto', // allow-italian: fixture data, shown as written
  subappalto: 'Subappalto', // allow-italian: fixture data, shown as written
  fornitura: 'Fornitura', // allow-italian: fixture data, shown as written
  personale: 'Personale', // allow-italian: fixture data, shown as written
  sindacale: 'Accordo sindacale', // allow-italian: fixture data, shown as written
};

/** The step of an approval chain, as a noun: «Approvazione». (allow-italian: quotes the Italian interface) */
export const actionLabel: Record<ApprovalStep['action'], string> = {
  redige: 'Redazione', // allow-italian: fixture data, shown as written
  rivede: 'Verifica', // allow-italian: fixture data, shown as written
  approva: 'Approvazione', // allow-italian: fixture data, shown as written
  firma: 'Firma', // allow-italian: fixture data, shown as written
  controfirma: 'Controfirma', // allow-italian: fixture data, shown as written
};

/* ---------- alerts ---------- */

export interface ContractAlert {
  id: string;
  tone: 'warn' | 'error' | 'info';
  kind: 'rinnovo' | 'preavviso' | 'penale' | 'scaduto' | 'obbligo' | 'variante'; // allow-italian: values compared by value
  title: string;
  body: string;
  /** The clause the alert comes from, when there is one. */
  clause?: string;
}

const TONE_RANK: Record<ContractAlert['tone'], number> = { error: 0, warn: 1, info: 2 };

const days = (n: number) => `${n} ${n === 1 ? 'giorno' : 'giorni'}`; // allow-italian: alert copy of the SARIM edition, shown as written

const clauseNumber = (contract: Contract, clauseId: string) => clauseIn(currentVersion(contract), clauseId)?.n ?? clauseId;

/**
 * What a contract asks for today, most urgent first: expired, notice within
 * 90 days (180 as information), obligations past their date, penalty clauses
 * with an open card on them, variants in progress. Computed from the dates
 * every time, never stored: an obligation becomes late by itself.
 */
export function contractAlerts(contract: Contract, today: string = DEMO_TODAY, cards: SarimCard[] = world().cards): ContractAlert[] {
  const out: ContractAlert[] = [];
  const durationClause = currentVersion(contract).clauses.find((c) => c.title.startsWith('Durata'))?.id; // allow-italian: compares the clause title by value

  if (contract.end && (contract.status === 'scaduto' || contract.end < today)) {
    out.push({
      id: `${contract.id}:scaduto`, tone: 'error', kind: 'scaduto', clause: durationClause, // allow-italian: values compared by value
      title: `Scaduto il ${dayLabel(contract.end, today)}`, // allow-italian: alert copy of the SARIM edition, shown as written
      body: `Scaduto da ${days(daysTo(today, contract.end))}: se il servizio prosegue, serve l'atto che copre il periodo dopo la scadenza.`, // allow-italian: alert copy of the SARIM edition, shown as written
    });
  }

  const notice = noticeDate(contract);
  if (notice && contract.end >= today) {
    const left = daysTo(notice, today);
    const tacit = contract.renewal.kind === 'tacito';
    const clause = contract.obligations.find((o) => o.kind === 'rinnovo')?.clause ?? durationClause;
    if (left >= 0 && left <= 90) {
      out.push({
        id: `${contract.id}:preavviso`, tone: left <= 30 ? 'error' : 'warn', kind: 'preavviso', clause, // allow-italian: values compared by value
        title: tacit ? `Disdetta entro il ${dayLabel(notice, today)}` : `Proroga da decidere entro il ${dayLabel(notice, today)}`, // allow-italian: alert copy of the SARIM edition, shown as written
        body: tacit // allow-italian: alert copy of the SARIM edition, shown as written
          ? `Mancano ${days(left)}. Senza disdetta il contratto si rinnova da solo per ${contract.renewal.months} mesi.` // allow-italian: alert copy of the SARIM edition, shown as written
          : `Mancano ${days(left)}. La proroga vale ${contract.renewal.months} mesi alle stesse condizioni.`, // allow-italian: alert copy of the SARIM edition, shown as written
      });
    } else if (left > 90 && left <= 180) {
      out.push({
        id: `${contract.id}:rinnovo`, tone: 'info', kind: 'rinnovo', clause, // allow-italian: values compared by value
        title: tacit ? `Rinnovo tacito: disdetta entro il ${dayLabel(notice, today)}` : `Proroga da valutare entro il ${dayLabel(notice, today)}`, // allow-italian: alert copy of the SARIM edition, shown as written
        body: `Mancano ${days(left)} al termine per ${tacit ? 'la disdetta' : 'la decisione'}.`, // allow-italian: alert copy of the SARIM edition, shown as written
      });
    }
  }

  for (const o of contract.obligations) {
    if (o.done || !o.due || o.due >= today) continue;
    out.push({
      id: `${contract.id}:${o.id}`, tone: 'error', kind: 'obbligo', clause: o.clause, // allow-italian: values compared by value
      title: `In ritardo: ${o.what}`, // allow-italian: alert copy of the SARIM edition, shown as written
      body: `Scadeva il ${dayLabel(o.due, today)}, ${days(daysTo(today, o.due))} fa (art. ${clauseNumber(contract, o.clause)}).`, // allow-italian: alert copy of the SARIM edition, shown as written
    });
  }

  for (const o of contract.obligations.filter((x) => x.kind === 'penale')) {
    const open = cards.filter((c) => c.links?.contract === contract.id && c.links.clause === o.clause && stageOf(c) !== 'fatto'); // allow-italian: values compared by value
    for (const card of open) {
      out.push({
        id: `${contract.id}:${o.id}:${card.id}`, tone: 'warn', kind: 'penale', clause: o.clause, // allow-italian: values compared by value
        title: `Penale in gioco, art. ${clauseNumber(contract, o.clause)}`, // allow-italian: alert copy of the SARIM edition, shown as written
        body: `${card.id}: ${card.title}. ${o.what}.`,
      });
    }
  }

  for (const v of contract.variants.filter((x) => x.status === 'in-corso')) {
    const waiting = contract.approvals.find((s) => s.state === 'in-attesa');
    const who = waiting ? `${personaById(waiting.who)?.name ?? waiting.who}, ${actionLabel[waiting.action].toLowerCase()}` : '';
    out.push({
      id: `${contract.id}:${v.id}`, tone: 'info', kind: 'variante', // allow-italian: values compared by value
      title: `Variante in corso: ${v.title}`, // allow-italian: alert copy of the SARIM edition, shown as written
      body: `Versione ${v.version}, ${formatShare(variantShare(contract, v.version))} sul valore della prima versione firmata.${who ? ` Aspetta: ${who}.` : ''}`, // allow-italian: alert copy of the SARIM edition, shown as written
    });
  }

  return out.sort((p, q) => TONE_RANK[p.tone] - TONE_RANK[q.tone]);
}

/* ---------- the dates of a contract ---------- */

/** A day a contract asks for: its end, the last day for its notice, the day of an obligation. */
export interface ContractDate {
  id: string;
  day: string;
  kind: 'end' | 'notice' | 'obligation';
  contract: Contract;
  /** The clause the day is read from. */
  clause?: string;
  obligation?: Obligation;
  done: boolean;
}

/**
 * Every dated day of the contracts, read from the clauses: «Contratti», its (allow-italian: quotes the Italian interface)
 * calendar and the deadlines of «Dati» all start from this list, so a date (allow-italian: quotes the Italian interface)
 * cannot differ between them. A done obligation stays, marked done.
 */
export function contractDates(contracts: Contract[]): ContractDate[] {
  const out: ContractDate[] = [];
  for (const c of contracts) {
    const duration = currentVersion(c).clauses.find((x) => x.title.startsWith('Durata'))?.id; // allow-italian: clause title compared by value
    const renewal = c.obligations.find((o) => o.kind === 'rinnovo')?.clause ?? duration; // allow-italian: data code compared by value
    if (c.end) out.push({ id: `${c.id}:end`, day: c.end, kind: 'end', contract: c, clause: duration, done: false });
    const notice = noticeDate(c);
    if (notice) out.push({ id: `${c.id}:notice`, day: notice, kind: 'notice', contract: c, clause: renewal, done: false });
    for (const o of c.obligations) {
      if (o.due) out.push({ id: `${c.id}:${o.id}`, day: o.due, kind: 'obligation', contract: c, clause: o.clause, obligation: o, done: Boolean(o.done) });
    }
  }
  return out;
}
