/**
 * The view models of the contracts layer: what a contract screen needs to draw
 * itself (a row of the list, a clause of the text, a line of a comparison, a
 * step of the approval chain), already in words and tones. The edition fills
 * them from its live world; the components never see where they come from.
 */
import type { LucideIcon } from 'lucide-react';
import type { Tone } from '../types';

/** A person or an agent as a list shows it: initials in a colour, or the agent glyph. */
export interface ActorModel {
  name: string;
  monogram: string;
  color: string;
  agent?: boolean;
  /** One quiet line under the name: the role, what it is doing. */
  detail?: string;
}

/* ---------- the list ---------- */

export interface ContractRowModel {
  id: string;
  kindText: string;
  title: string;
  counterparty: string;
  counterpartyKind: string;
  statusText: string;
  statusTone: Tone;
  valueText: string;
  /** Under the value: «all'anno», «oltre IVA», the share of a variation. (allow-italian: quotes the Italian interface) */
  valueDetail?: string;
  startText: string;
  endText: string;
  /** The end is not a date (not published): drawn quieter. */
  endMissing?: boolean;
  noticeText: string;
  /** There is no notice date: the cell shows the faint dash. */
  noticeMissing?: boolean;
  noticeDetail?: string;
  noticeTone?: Tone;
  renewalText: string;
  /** The contract does not renew: the cell shows the faint dash. */
  renewalMissing?: boolean;
  alerts: number;
  alertTone: Tone;
  /** The worst alert, as the tooltip of the count. */
  alertTitle?: string;
}

/* ---------- the head of a contract ---------- */

export interface FactModel {
  label: string;
  value: string;
  /** A quiet line under the value. */
  detail?: string;
  mono?: boolean;
}

export interface FamilyNodeModel {
  id: string;
  /** What it is to this contract: «Contratto principale», «Subappalto, art. 11», «Variante v3». (allow-italian: quotes the Italian interface) */
  relation: string;
  title: string;
  statusText?: string;
  statusTone?: Tone;
  /** This contract itself, in the middle of its family. */
  current?: boolean;
}

export interface AlertModel {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  /** The clause it comes from («art. 9»), when there is one: the alert opens it. (allow-italian: quotes the Italian interface) */
  clauseLabel?: string;
  /** That clause is already the one on show: the alert names it without opening it again. */
  here?: boolean;
}

/* ---------- the text ---------- */

export interface ClauseBadgeModel {
  id: string;
  label: string;
  tone: Tone;
  /** Opens what the badge talks about (a comparison, a variation). */
  opens?: boolean;
}

export interface ClauseBlockModel {
  /** The stable clause id (`art-9`), the `data-clause` hook. */
  id: string;
  /** As printed: «9». (allow-italian: quotes the Italian interface) */
  n: string;
  title: string;
  text: string;
  /** Words of the text to light up (an obligation's quote), verbatim. */
  mark?: string;
  focused?: boolean;
  /** Which list of this clause the side panel shows now, if any: its count is the current one. */
  sideOpen?: 'comments' | 'obligations';
  comments: number;
  openComments: number;
  obligations: number;
  badges: ClauseBadgeModel[];
}

/* ---------- the comparison ---------- */

export interface DiffPartModel {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface CompareRowModel {
  id: string;
  n: string;
  title: string;
  status: 'same' | 'changed' | 'added' | 'removed';
  /** The older text with what it loses, and the newer with what it gains. */
  left: DiffPartModel[];
  right: DiffPartModel[];
  /** Both in one run, for a phone. */
  inline: DiffPartModel[];
}

/* ---------- the side panel ---------- */

export interface ObligationModel {
  id: string;
  what: string;
  clauseLabel: string;
  kindText: string;
  kindTone: Tone;
  owner: ActorModel;
  /** «entro il 10/11 · tra 4 giorni», «ogni mese, dopo il visto del RUP». (allow-italian: quotes the Italian interface) */
  whenText: string;
  whenTone?: Tone;
  every?: string;
  done: boolean;
  /** How it was closed: the proof, who, when. */
  proof?: string;
  /** The words of the clause it comes from. */
  quote: string;
  /** The version the words were read in, when it is not the one on show. */
  versionNote?: string;
  /** A card of «Da fare» working on it. (allow-italian: quotes the Italian interface) */
  card?: { id: string; label: string };
  focused?: boolean;
}

export interface CommentModel {
  id: string;
  clauseLabel: string;
  author: ActorModel;
  at: string;
  text: string;
  resolved: boolean;
  /** The text of the clause changed since the comment was written (it names the version). */
  changedNote?: string;
  /** Its clause, in its version, is the one on show: the chip names it without opening it again. */
  here?: boolean;
  replies: Array<{ id: string; author: ActorModel; at: string; text: string }>;
}

export interface VersionModel {
  n: number;
  label: string;
  author: ActorModel;
  /** The agent that drafted it, when a person reviewed it after. */
  draftedBy?: string;
  at: string;
  reason: string;
  /** What made it: «Caricata», «Variante», «Firmata». (allow-italian: quotes the Italian interface) */
  originText: string;
  signed: boolean;
  inForce: boolean;
  draft: boolean;
  /** The unsigned version a chain of approval is on: named like the card that carries it. */
  toApprove: boolean;
  valueText?: string;
  onShow: boolean;
}

export interface AttachmentModel {
  id: string;
  name: string;
  kindText: string;
  kindTone: Tone;
  detail: string;
}

export interface LinkModel {
  id: string;
  kind: 'flow' | 'card';
  /** The icon of this flow, as Da fare and Flussi draw it; the generic flow glyph when absent. (allow-italian: quotes the Italian interface) */
  icon?: LucideIcon;
  title: string;
  detail: string;
  statusText?: string;
  statusTone?: Tone;
}

/* ---------- approvals and signatures ---------- */

export interface ApprovalStepModel {
  id: string;
  order: number;
  who: ActorModel;
  actionText: string;
  stateText: string;
  stateTone: Tone;
  at?: string;
  note?: string;
  /** Why this person is in the chain. */
  why?: string;
  /** Changes asked on this step: what and who. */
  request?: string;
  current: boolean;
}

export interface PermissionRowModel {
  id: string;
  team: string;
  people: ActorModel[];
  /** The team's level on Contratti, as «Squadra › Permessi» names it: Niente, Vede, Lavora, Gestisce. (allow-italian: quotes the Italian interface) */
  level: string;
  levelTone: Tone;
  /** What the team may also do, under the level: «Approva contratti», «Firma contratti». */
  can: string[];
  /** People who have another level than their team, one line each: «Nome: Lavora». (allow-italian: quotes the Italian interface) */
  exceptions: string[];
  /** What the people of this team do in this contract's chain. */
  inChain?: string;
  you: boolean;
}

/** A document as printed: its lines, and for a signed copy the signature block. */
export interface PaperModel {
  title: string;
  kindText: string;
  versionText?: string;
  at: string;
  lines: string[];
  signature?: { lines: string[]; hash: string };
}
