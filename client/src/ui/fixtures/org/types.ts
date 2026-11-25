/**
 * The example cases of the organizations preview, as plain data: what arrived,
 * what the AI read in it (each value with the words it comes from), the steps,
 * the deadlines with the rule that fixes them, the originals (real PDF files
 * and page images under `client/public-ui/docs/`), the history.
 *
 * This is a domain seed, not a view model: the container of the preview
 * (`client/src/ui-gallery/app/`) turns a seed plus the reader's actions into
 * the models the screens draw (queue, record, table row, deadline, card).
 *
 * Facts about the organization come from `DATI-VERI.md` only; people,
 * taxpayers, case numbers and amounts are examples and every case says so
 * (`example: true`, counterpart labelled «esempio»). (allow-italian: quotes the Italian interface)
 */
import type { RichTextModel } from '../../types';
import type { DraftBlockModel } from '../../record/model';

export type OrgKey = 'nocera' | 'orbit' | 'armonia' | 'euro';

export type CaseKind =
  | 'ricorso' | 'sgravio' | 'concessione' | 'accesso' | 'segnalazione' | 'fattura'
  | 'verbale' | 'irrigazione' | 'regione' | 'send'
  | 'rifiuti' | 'foglie' | 'fir';

/** Where a case is in its life. `da-confermare`: the AI classified it and a person has to confirm. (allow-italian: quotes the Italian interface) */
export type CaseStatus = 'da-confermare' | 'in-lavorazione' | 'in-attesa' | 'chiusa'; // allow-italian: identifier compared by value, not shown

export type Channel = 'pec' | 'mail' | 'whatsapp' | 'telefono' | 'sdi' | 'sportello' | 'teams' | 'portale';

/** The offices of the example organization; the label comes from `OFFICE_LABEL`. */
export type Office =
  | 'protocollo' | 'legale' | 'catasto' | 'tecnico' | 'manutenzione' | 'ragioneria' | 'segreteria' | 'irrigazione' | 'direzione'
  | 'call-center' | 'amministrazione' | 'servizi';

/** A page-level citation of an original: the words around the value, the value itself highlighted. */
export interface CaseQuote {
  doc: string;
  page: number;
  before: string;
  highlight: string;
  after: string;
}

/** A value the AI read and a person confirms or corrects (n12, v02). */
export interface CaseField {
  id: string;
  label: string;
  value: string;
  /** Short form for the button that applies it, e.g. `04/01`. */
  short?: string;
  /** 0-100; under 85 it reads amber and goes to a person. */
  confidence: number;
  source: CaseQuote;
  /** Why this value, in plain words, with citations. */
  reasoning: RichTextModel;
  /** How many documents and rules were read to decide it. */
  consulted: number;
}

/**
 * A deadline and the rule that fixes it. `date` must equal `from + days` moved
 * past a Saturday, Sunday or public holiday when `rollsOver` (art. 155 c.p.c.);
 * `scripts/ui-fixtures-check.ts` recomputes every one of them.
 */
export interface CaseDeadline {
  id: string;
  label: string;
  /** YYYY-MM-DD, the event the term runs from (a delivery receipt, a filing). */
  from: string;
  days: number;
  date: string;
  rollsOver: boolean;
  /** The norm, e.g. `art. 23 D.Lgs. 546/1992`. */
  rule: string;
  /** The computation in plain words, e.g. «60 giorni dalla consegna della PEC del 05/11/2026». (allow-italian: quotes the Italian interface) */
  calc: string;
  office: Office;
}

export type StepState = 'done' | 'current' | 'todo';

/** A stage of the case, as its flow defines it. */
export interface CaseStep {
  id: string;
  label: string;
  /** The step of the flow that brings the case here (`/flussi/<flow>/passo/<id>`). */
  flowStep?: string;
  state: StepState;
  /** YYYY-MM-DD HH:mm when done. */
  at?: string;
  by?: string;
}

/** An original. Every one exists as a file: `pages` are images, `pdf` the document. */
export interface CaseDocument {
  id: string;
  name: string;
  kind: 'pdf' | 'image' | 'mail' | 'xml';
  /** One line: what it is, pages, signature. */
  detail: string;
  from?: string;
  /** ISO date-time. */
  receivedAt?: string;
  signed?: boolean;
  draft?: boolean;
  /** URLs relative to the app page, e.g. `docs/2418/d-ricorso-1.jpg`. */
  pages: string[];
  pdf?: string;
  /** The AI summary shown next to the original (v01), each point tied to its page. */
  summary: Array<{ text: string; page: number }>;
  /** The text of each page, for search and for the words around a value. */
  text: string[];
}

export interface CaseEvent {
  /** YYYY-MM-DD HH:mm */
  at: string;
  who: string;
  what: string;
  doc?: string;
}

/** The action that closes the current phase, simulated with a realistic receipt. */
export interface CasePrimaryAction {
  label: string;
  kind: 'deposit' | 'send-pec' | 'pay' | 'order' | 'reply' | 'grant' | 'reject-invoice';
  /** What the receipt says once done, e.g. the PEC delivery receipt. */
  receipt: { title: string; lines: string[] };
}

export interface CaseSeed {
  id: string;
  org: OrgKey;
  kind: CaseKind;
  /** Short title for lists, e.g. «Ricorso CGT, azienda agricola». */
  title: string;
  /** The subject as written in the original. */
  subject: string;
  office: Office;
  /** The flow that handles it (`/flussi/<flow>`). */
  flow: string;
  channel: Channel;
  /** ISO date-time. */
  arrivedAt: string;
  protocol?: { number: string; date: string };
  /** Always an example, and labelled so: «Azienda agricola (esempio)». (allow-italian: quotes the Italian interface) */
  counterpart: string;
  status: CaseStatus;
  urgent?: boolean;
  /** Persona id of who has it now (see `people.ts`). */
  assignee: string;
  amount?: number;
  comune?: string;
  parcel?: { comune: string; foglio: string; particella: string; canale?: string };
  fields: CaseField[];
  deadlines: CaseDeadline[];
  steps: CaseStep[];
  documents: CaseDocument[];
  history: CaseEvent[];
  /** The draft the AI prepared, with proposals a person accepts or discards. */
  draft?: { file: string; meta: string; blocks: DraftBlockModel[] };
  assistant?: {
    description: string;
    turns: Array<{ role: 'user' | 'assistant'; text: RichTextModel }>;
    /** `closedByConfirm`: the item that confirming the case ticks by itself. */
    checklist: Array<{ id: string; text: string; done: boolean; closedByConfirm?: boolean }>;
  };
  /** Ids of related cases. */
  related?: string[];
  /** Knowledge ids the case cites, `<item>/<article>` (e.g. `lr-7-2025/a9c3`). */
  norms?: string[];
  primaryAction: CasePrimaryAction;
  /** One line under the title: what the AI understood, e.g. «Legale · costituzione entro 04/01». */
  proposal: string;
  example: true;
}

/** What a step of a flow is, which decides its glyph and the page that configures it. */
export type FlowStepKind = 'classify' | 'ai' | 'rule' | 'robot' | 'person' | 'program' | 'view' | 'send';

export interface FlowStepSeed {
  id: string;
  label: string;
  kind: FlowStepKind;
  /** The program a robot or program step works in (Halley, Prunes, ...). */
  program?: string;
  office?: Office;
}

/** A flow of an organization, as the list of flows shows it (n01). */
export interface FlowSeed {
  id: string;
  org: OrgKey;
  name: string;
  /** What starts it, in plain words: «arriva una PEC». (allow-italian: quotes the Italian interface) */
  trigger: string;
  office: Office;
  status: 'attivo' | 'collaudo' | 'bozza' | 'spento'; // allow-italian: identifier compared by value, not shown
  version: number;
  /** Items per month, an estimate (the overview sums them). */
  perMonth: number;
  steps: FlowStepSeed[];
}
