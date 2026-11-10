/**
 * The shapes of the ORBIT edition's example world: the work on «Da fare» (allow-italian: quotes the Italian interface)
 * (stages, cards), the flows that move it, and the contracts (allow-italian: quotes the Italian interface)
 * with their versions. Plain data, the same for every screen: the kanban, the
 * stage view, «Dati», «Contratti» and the sidebar all count from these
 * lists, so a number printed in two places cannot disagree
 * (`scripts/ui-fixtures-check.ts` checks the rest). (allow-italian: quotes the Italian interface)
 *
 * Facts about ORBIT come from `DATI-VERI-ORBIT.md` only (public sources and
 * the internal questionnaire); people other than Avv. Annarita Bruno, single
 * cards, contract values and dates are examples, coherent across screens.
 */
import type { OrbitArea } from './people';

/* ---------- the kanban of «Da fare» ---------- (allow-italian: quotes the Italian interface) */

/** The columns of «Da fare», in order. Ids are the values of the `stato` filter (`verifica`). (allow-italian: quotes the Italian interface) */
export type StageId = 'arrivo' | 'lavorazione' | 'verifica' | 'approvazione' | 'fatto'; // allow-italian: address segments, compared by value

export interface Stage {
  id: StageId;
  label: string;
  /** One line under the column title: what being here means. */
  hint: string;
}

/** Who has the card in hand right now: a person of ORBIT or an agent of Topics. */
export type Worker =
  | { kind: 'person'; id: string; doing: string; since: string }
  | { kind: 'agent'; id: string; doing: string; since: string };

/** An original the card carries, shown beside its values (a mail, a photo, a form, an invoice, a call notice). */
export interface CardOriginal {
  id: string;
  name: string;
  /** What kind of paper it is, for the icon and the viewer. */
  kind: 'mail' | 'photo' | 'screen' | 'form' | 'invoice' | 'tender' | 'sheet' | 'letter' | 'call';
  /** Where it came from: «mail AMA», «portale utenze», «SDI», «portale gare Innova»… (allow-italian: quotes the Italian interface) */
  from: string;
  at: string;
  /** The text as it is written on the original, one string per paragraph or line. */
  lines: string[];
  /** The picture of a photo or a screen, relative to the page (a real capture, never drawn). */
  image?: string;
}

/** A value the agent read on an original, with the words it comes from. */
export interface CardValue {
  label: string;
  value: string;
  /** The original and the words (verbatim, on one of its `lines`). */
  doc: string;
  quote: string;
  /** 0-100; under 85 the card asks a person to look at it. */
  confidence: number;
}

/** A column the card went through, with when it entered it (oldest first; the last one is where it is). */
export interface StageEntry {
  stage: StageId;
  at: string;
  /** Who moved it there: `agent:<id>` or a persona id. */
  by: string;
}

export interface OrbitCard {
  /** Shown on the card and in addresses: `SG-4127`, `FIR-0931`, `FT-2611`, `GA-031`, `PE-118`, `CT-V07`. */
  id: string;
  /** The flow that moves it (`ORBIT_OPS_FLOWS`). */
  flow: string;
  /** The id of the step of that flow the card is at (for a card in «Fatto», the last step). (allow-italian: quotes the Italian interface) */
  step: string;
  title: string;
  /** One line: the comune, the supplier, the amount, the contract. */
  detail: string;
  /** The comune or committente it is about, when there is one. */
  place?: string;
  history: StageEntry[];
  /** Who is working on it now; a card in «Fatto» keeps who closed it. (allow-italian: quotes the Italian interface) */
  worker: Worker;
  /** The person who must check or approve before it moves on. */
  reviewer: string;
  /** Last useful day (`YYYY-MM-DD`), when the process has one. */
  due?: string;
  priority: 'alta' | 'normale' | 'bassa'; // allow-italian: values compared by value
  /** Set when the card is stopped on something outside it: what it waits for, since when. */
  blocked?: { reason: string; since: string };
  originals: CardOriginal[];
  values: CardValue[];
  /** What the agent proposes, in one sentence (the draft a person checks). */
  proposal: string;
  /** Links to the rest of the app. */
  links?: { contract?: string; clause?: string; card?: string };
  /** In a flow that splits into cases (`FlowSplitDef`): the case of this card, once the flow has recognized it. */
  lane?: string;
}

/* ---------- flows of the ORBIT edition ---------- */

export interface OpsFlowStep {
  id: string;
  title: string;
  /** Who does it: a rule, an agent, a program (by name) or a person (by persona id). */
  actor: { kind: 'rule' } | { kind: 'agent'; id: string } | { kind: 'program'; name: string } | { kind: 'person'; id: string };
  /** The column a card at this step stands in. */
  stage: StageId;
}

export interface OpsFlow {
  id: string;
  /** The one short name of the flow, the same on every screen. */
  name: string;
  /** What the flow ends with (the thing it hands over): a subtitle where the flows are listed, never part of the name. */
  outcome?: string;
  area: OrbitArea;
  /** What enters it, in plain words. */
  source: string;
  /** The agent that prepares its cards. */
  agent: string;
  /** Hours in the same column after which a card counts as stopped (not counted in «Fatto»). (allow-italian: quotes the Italian interface) */
  stuckAfterHours: number;
  trigger: string;
  status: 'attivo' | 'collaudo' | 'bozza'; // allow-italian: status codes of the data, not shown
  version: number;
  /** Items per month, an estimate («stima» on screen). (allow-italian: quotes the Italian interface) */
  perMonth: number;
  /** The programs it reads or writes (`Programmi`). (allow-italian: quotes the Italian interface) */
  programs: string[];
  steps: OpsFlowStep[];
}

/* ---------- contracts ---------- */

export type ContractKind = 'servizio' | 'appalto' | 'subappalto' | 'fornitura' | 'personale' | 'sindacale'; // allow-italian: values compared by value

export type ContractStatus = 'bozza' | 'revisione' | 'approvazione' | 'firma' | 'attivo' | 'rinnovo' | 'scaduto'; // allow-italian: values compared by value

export interface Clause {
  id: string;
  /** As printed: «1», «4.2», «Art. 7». (allow-italian: quotes the Italian interface) */
  n: string;
  title: string;
  text: string;
}

export interface ContractVersion {
  n: number;
  /** A persona id, or `agent:<id>` for a draft an agent prepared. */
  author: string;
  at: string;
  reason: string;
  clauses: Clause[];
  /** Signed by both sides: the version in force. */
  signed?: boolean;
  /** The contract value in euro this version sets, when it changes it (a variant, a price review); otherwise the value of the version before holds. */
  value?: number;
  /** The agent that prepared the first draft (`agent:<id>`), when `author` is the person who reviewed and rewrote it. */
  draftedBy?: string;
}

/** An obligation or a deadline read in the text, always with the clause it comes from. */
export interface Obligation {
  id: string;
  clause: string;
  /** The version whose text it was read from. */
  version: number;
  what: string;
  /** Who in ORBIT has to do it. */
  owner: string;
  kind: 'scadenza' | 'ricorrente' | 'penale' | 'rinnovo' | 'rendiconto' | 'garanzia'; // allow-italian: values compared by value
  /** The next date it falls on (`YYYY-MM-DD`), when it has one. */
  due?: string;
  /** For a recurring one, how it repeats, in words: «entro il 10 di ogni mese». (allow-italian: quotes the Italian interface) */
  every?: string;
  /** The words of the clause it comes from, verbatim: the screen highlights them in the original. */
  quote: string;
  done?: boolean;
}

export interface ClauseComment {
  id: string;
  clause: string;
  version: number;
  author: string;
  at: string;
  text: string;
  resolved?: boolean;
  replies?: Array<{ author: string; at: string; text: string }>;
}

export interface ContractAttachment {
  id: string;
  name: string;
  kind: 'firmato' | 'allegato' | 'variante' | 'verbale' | 'garanzia'; // allow-italian: values compared by value
  /** The version it belongs to. */
  version?: number;
  at: string;
  /** The text of the document as printed, one string per paragraph. */
  lines: string[];
}

/** A change of a contract in force: it starts the approval flow and, once signed, becomes a version. */
export interface ContractVariant {
  id: string;
  title: string;
  reason: string;
  /** The version it produces. */
  version: number;
  status: 'in-corso' | 'approvata' | 'firmata' | 'respinta'; // allow-italian: values compared by value
  /** The card of the approval in «Da fare», flow `orbit-varianti`. (allow-italian: quotes the Italian interface) */
  card?: string;
  at: string;
}

/** One step of the approval chain of the current version: who, what, done or waiting. */
export interface ApprovalStep {
  id: string;
  /** A persona id. */
  who: string;
  action: 'redige' | 'rivede' | 'approva' | 'firma' | 'controfirma'; // allow-italian: values compared by value
  state: 'fatto' | 'in-attesa' | 'da-fare'; // allow-italian: values compared by value
  at?: string;
  note?: string;
}

export interface Contract {
  id: string;
  title: string;
  kind: ContractKind;
  counterparty: string;
  /** What the counterparty is: «Comune», «Committente», «Fornitore», «Subappaltatore», «Sindacati», «Lavoratore». (allow-italian: quotes the Italian interface) */
  counterpartyKind: string;
  /** One line: what ORBIT does or receives. */
  object: string;
  /** Value in euro (VAT excluded), and over what period. */
  value: number;
  valuePeriod: 'anno' | 'totale' | 'mese'; // allow-italian: values compared by value
  start: string;
  end: string;
  renewal: { kind: 'tacito' | 'opzione' | 'nessuno'; months: number; noticeDays: number }; // allow-italian: values compared by value
  status: ContractStatus;
  owner: string;
  area: OrbitArea;
  /** Public tender code, when there is one (example). */
  cig?: string;
  versions: ContractVersion[];
  obligations: Obligation[];
  comments: ClauseComment[];
  attachments: ContractAttachment[];
  variants: ContractVariant[];
  approvals: ApprovalStep[];
  /** The flows and cards it is linked to. */
  links: { flows: string[]; cards: string[] };
  tags?: string[];
}
