/**
 * What the contract screens derive from the live world: who a person or an
 * agent is on screen, which contracts a saved view holds, the family of a
 * contract, where an approval chain stands, the card that follows a contract on
 * «Da fare», and every dated event of every contract (end, notice, reminders, (allow-italian: quotes the Italian interface)
 * obligations). Pure functions: the numbers on the list, the tiles, the
 * calendar and the contract page all come from here and from `model/`.
 */
import type { ApprovalStep, Clause, Contract, ContractStatus, ContractVersion, Obligation, SarimCard, StageId } from '../../../../ui/fixtures/sarim-org/types';
import { agentById, personaById, teamById, teamIdOfPerson, world } from '../../world';
import type { Tone } from '../../../../ui/types';
import type { ActorModel } from '../../../../ui/contracts/model';
import { addDays } from '../../../../ui/fixtures/org/clock';
import { contractAlerts, contractDates, currentVersion, daysTo, latestVersion, noticeDate, versionOf } from '../../model/contracts';
import { stageOf } from '../../model/live';

/* ---------- people and agents ---------- */

/** A persona id, `agent:<id>` or an agent id, as a list draws it. */
export function actorOf(id: string): ActorModel {
  const agentId = id.startsWith('agent:') ? id.slice(6) : id;
  const agent = agentById(agentId);
  if (agent) return { name: agent.name, monogram: '', color: '', agent: true, detail: agent.does };
  const p = personaById(id);
  if (!p) return { name: id, monogram: '?', color: '#64748b' };
  return { name: p.name, monogram: p.monogram, color: p.color, detail: teamLabelOf(p.id) };
}

/** The team of a person, by its name: the board of auditors reads as «Collegio sindacale», not as a role. */
export function teamLabelOf(personaId: string): string {
  return teamById(teamIdOfPerson(personaId) ?? '')?.label ?? '';
}

export const isDirection = (personaId: string) => personaById(personaId)?.role === world().people.managerRole;
export const isReadOnly = (personaId: string) => personaById(personaId)?.role === world().people.viewerRole;

/* ---------- dates ---------- */

/** `03/11/2026 17:10` from an ISO date-time written in Rome time. */
export function stamp(iso: string): string {
  const [day, time] = iso.split('T');
  const [y, m, d] = day.split('-');
  return time ? `${d}/${m}/${y} ${time.slice(0, 5)}` : `${d}/${m}/${y}`;
}

/** `03/11/2026` */
export function longDay(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/* ---------- state of a contract ---------- */

export const STATUS_TONE: Record<ContractStatus, Tone> = {
  bozza: 'neutral', // allow-italian: data codes mapped to tones
  revisione: 'amber',
  approvazione: 'amber',
  firma: 'blue',
  attivo: 'green',
  rinnovo: 'blue',
  scaduto: 'red', // allow-italian: data codes mapped to tones
};

/** A public client (a comune, AMA): variations follow art. 120 of D.Lgs. 36/2023. */
export const isPublic = (c: Contract) => c.counterpartyKind === 'Comune' || c.counterpartyKind === 'Committente'; // allow-italian: data values compared by value

export const runningVariant = (c: Contract) => c.variants.find((v) => v.status === 'in-corso'); // allow-italian: data value compared by value

export function isExpired(c: Contract, today: string): boolean {
  return c.status === 'scaduto' || Boolean(c.end && c.end < today); // allow-italian: data value compared by value
}

/** In force: signed, not expired, not still waiting for its first signature. */
export function inForce(c: Contract, today: string): boolean {
  return (c.status === 'attivo' || c.status === 'rinnovo') && Boolean(currentVersion(c).signed) && !isExpired(c, today); // allow-italian: data values compared by value
}

/** The default comparison: the version being worked on against the last signed one before it; between the last two signed when none is open. */
export function defaultPair(c: Contract): { from: number; to: number } | undefined {
  if (c.versions.length < 2) return undefined;
  const to = latestVersion(c).n;
  const before = c.versions.filter((v) => v.n < to);
  const signed = before.filter((v) => v.signed);
  const from = (signed.length ? signed : before).reduce((a, b) => (b.n > a.n ? b : a)).n;
  return { from, to };
}

/** The clause that carries the value: «Corrispettivo», «Importo», «Valore». (allow-italian: quotes the Italian interface) */
export function valueClauseOf(v: ContractVersion): Clause | undefined {
  return v.clauses.find((c) => /^(Corrispettivo|Importo|Valore)/.test(c.title)); // allow-italian: clause titles compared by value
}

/** The latest version up to `n` in which a clause changed, with the version before it. */
export function lastChange(c: Contract, clauseId: string, n: number): { from: number; to: number } | undefined {
  const ordered = [...c.versions].sort((a, b) => a.n - b.n).filter((v) => v.n <= n);
  for (let i = ordered.length - 1; i > 0; i--) {
    const now = ordered[i].clauses.find((x) => x.id === clauseId);
    const was = ordered[i - 1].clauses.find((x) => x.id === clauseId);
    if (now && (!was || was.text !== now.text)) return { from: ordered[i - 1].n, to: ordered[i].n };
  }
  return undefined;
}

/** The text a clause has in a version, or undefined. */
export const clauseText = (c: Contract, n: number, clauseId: string) => versionOf(c, n)?.clauses.find((x) => x.id === clauseId)?.text;

/* ---------- saved views ---------- */

export type SavedView = 'all' | 'expiring' | 'late' | 'variants' | 'expired';

/** The end or the notice day falls within 180 days. */
export function expiringSoon(c: Contract, today: string): boolean {
  const within = (day?: string) => Boolean(day && day >= today && daysTo(day, today) <= 180);
  return !isExpired(c, today) && (within(c.end) || within(noticeDate(c)));
}

/** An obligation past its day or a penalty at stake, from the same alerts the contract page shows. */
export const hasLateWork = (c: Contract, today: string, cards: SarimCard[]) => contractAlerts(c, today, cards).some((a) => a.kind === 'obbligo' || a.kind === 'penale'); // allow-italian: alert kinds compared by value

/* ---------- the family of a contract ---------- */

export type FamilyRelation = 'subcontract' | 'staff' | 'agreement';

/**
 * Which contract hangs from which, and how: the subcontract of the container
 * washing exists because of art. 11 of Castellabate, the fixed-term contracts
 * and the agreement on the 11 workers because of its service and art. 12.
 */
export const FAMILY: Array<{ child: string; parent: string; relation: FamilyRelation; clause?: string }> = world().contractFamily;

export function parentOf(id: string) {
  return FAMILY.find((f) => f.child === id);
}

export function childrenOf(id: string) {
  return FAMILY.filter((f) => f.parent === id);
}

/* ---------- the approval chain ---------- */

/** The step the chain waits on: the first not done. */
export function currentStep(chain: ApprovalStep[]): ApprovalStep | undefined {
  return chain.find((s) => s.state !== 'fatto'); // allow-italian: data value compared by value
}

export function stepAfter(chain: ApprovalStep[], id: string): ApprovalStep | undefined {
  const at = chain.findIndex((s) => s.id === id);
  return at < 0 ? undefined : chain.slice(at + 1).find((s) => s.state !== 'fatto'); // allow-italian: data value compared by value
}

/** The column of «Da fare» a card stands in while the chain waits on a step of this kind. (allow-italian: quotes the Italian interface) */
export function chainStage(action: ApprovalStep['action']): StageId {
  if (action === 'redige') return 'lavorazione'; // allow-italian: data codes compared by value
  if (action === 'rivede') return 'verifica'; // allow-italian: data codes compared by value
  if (action === 'controfirma') return 'lavorazione'; // allow-italian: data codes compared by value: the card stays open until the other side has signed
  return 'approvazione';
}

/** The chain has a step of approval or signature still open: the text is locked meanwhile. */
export const underApproval = (c: Contract) => c.approvals.some((s) => s.state !== 'fatto' && s.action !== 'redige'); // allow-italian: data codes compared by value

/** The card of «Da fare» that follows the contract's open work: the running variation's card, else an open card of the flow of contract variations. (allow-italian: quotes the Italian interface) */
export function linkedCard(c: Contract, cards: SarimCard[]): SarimCard | undefined {
  const running = runningVariant(c)?.card;
  if (running) {
    const card = cards.find((x) => x.id === running);
    if (card) return card;
  }
  return cards.find((x) => x.flow === world().flowRoles.variants && (c.links.cards.includes(x.id) || x.links?.contract === c.id) && stageOf(x) !== 'fatto'); // allow-italian: data codes compared by value
}

/** Every card that points at the contract, from its links and from the cards' own links. */
export function cardsOf(c: Contract, cards: SarimCard[]): SarimCard[] {
  return cards.filter((x) => c.links.cards.includes(x.id) || x.links?.contract === c.id);
}

/** The next free id of a variation card: `CT-V08` after `CT-V07`. */
export function nextVariantCardId(cards: SarimCard[]): string {
  const top = cards.reduce((n, c) => Math.max(n, /^CT-V(\d+)$/.test(c.id) ? Number(c.id.slice(4)) : 0), 0);
  return `CT-V${String(top + 1).padStart(2, '0')}`;
}

/* ---------- a signature, simulated ---------- */

/** A stable 64-hex fingerprint of a text, the shape of a SHA-256: the same text gives the same print. */
export function fingerprint(text: string): string {
  let out = '';
  for (let round = 0; out.length < 64; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

/** The number a signed document takes in SARIM's register of contracts. */
export function registerNumber(seed: string, year: string): string {
  const n = 100 + (parseInt(fingerprint(seed).slice(0, 6), 16) % 900);
  return `${world().words.refPrefix}/${year}/${String(n).padStart(4, '0')}`;
}

/* ---------- every dated event ---------- */

export interface ContractEvent {
  id: string;
  day: string;
  kind: 'end' | 'notice' | 'reminder' | 'obligation';
  contract: Contract;
  /** The clause the event is read from. */
  clause?: string;
  obligation?: Obligation;
  /** For a reminder: how many days before the notice. */
  lead?: number;
  done: boolean;
}

/**
 * The end of every contract, the last day for its notice, the reminders the
 * reader asked for before each notice (tacit renewals included), and the next
 * day of every obligation. A done obligation stays, marked done.
 */
export function contractEvents(contracts: Contract[], leads: number[], today: string): ContractEvent[] {
  const out: ContractEvent[] = [];
  for (const d of contractDates(contracts)) {
    out.push(d);
    if (d.kind !== 'notice') continue;
    for (const lead of leads) {
      const day = addDays(d.day, -lead);
      if (day >= today) out.push({ id: `${d.contract.id}:reminder:${lead}`, day, kind: 'reminder', contract: d.contract, clause: d.clause, lead, done: false });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}
