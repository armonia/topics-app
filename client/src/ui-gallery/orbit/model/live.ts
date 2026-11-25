/**
 * The ORBIT world as the reader changed it, on top of the fixtures:
 *  · the cards of the kanban, with the moves made by hand (drag, «Sposta in…», (allow-italian: quotes the Italian interface)
 *    a check, an approval), who took a card in hand, and the cards added in
 *    the preview (a new variation of a contract starts one);
 *  · the contracts, with the approval steps done, the comments added or
 *    resolved, the obligations closed, the versions and variations added, the
 *    versions signed.
 * Every screen and the sidebar read through `liveCards` and `liveContracts`,
 * so a card moved on the kanban is moved in the stage view and in the (allow-italian: quotes the Italian interface)
 * counts at the same time, and a contract approved in «Contratti» is approved (allow-italian: quotes the Italian interface)
 * on its card too. Changes go through the functions below, never by hand.
 */
import type { DemoState } from '../../app/store/state';
import type { ApprovalStep, ClauseComment, Contract, ContractStatus, ContractVariant, ContractVersion, OrbitCard, StageEntry, StageId, Worker } from '../../../ui/fixtures/orbit-org/types';
import { world } from '../world';

/* ---------- cards ---------- */

export const KANBAN_SLICE = 'orbit.kanban';

export interface KanbanSlice {
  /** Columns entered by hand, per card, oldest first (appended to the card's history). */
  moves: Record<string, StageEntry[]>;
  /** Who took a card in hand by hand. */
  workers: Record<string, Worker>;
  /** Cards made in the preview (a variation, a card from an obligation), newest last. */
  added: OrbitCard[];
  /** Values corrected by hand, per card, by value label. */
  values: Record<string, Record<string, string>>;
}

export const KANBAN_INITIAL: KanbanSlice = { moves: {}, workers: {}, added: [], values: {} };

export function kanbanSlice(state: DemoState): KanbanSlice {
  return { ...KANBAN_INITIAL, ...((state.slices[KANBAN_SLICE] as Partial<KanbanSlice> | undefined) ?? {}) };
}

/** A card with the reader's changes applied. */
export function liveCard(card: OrbitCard, slice: KanbanSlice): OrbitCard {
  const moves = slice.moves[card.id];
  const worker = slice.workers[card.id];
  const values = slice.values[card.id];
  if (!moves?.length && !worker && !values) return card;
  return {
    ...card,
    history: [...card.history, ...(moves ?? [])],
    worker: worker ?? card.worker,
    values: values ? card.values.map((v) => (values[v.label] !== undefined ? { ...v, value: values[v.label], confidence: 100 } : v)) : card.values,
  };
}

export function liveCards(state: DemoState): OrbitCard[] {
  const slice = kanbanSlice(state);
  return [...world().cards, ...slice.added].map((c) => liveCard(c, slice));
}

export function liveCardById(state: DemoState, id: string): OrbitCard | undefined {
  return liveCards(state).find((c) => c.id === id);
}

/** The column a card stands in now: the last one it entered. */
export function stageOf(card: OrbitCard): StageId {
  return card.history[card.history.length - 1]?.stage ?? 'arrivo';
}

/** When the card entered the column it stands in. */
export function stageSince(card: OrbitCard): string {
  return card.history[card.history.length - 1]?.at ?? '';
}

/** A thing that happened to a card without moving it to another column: someone took it in hand, or it stopped. */
export interface CardMoment {
  kind: 'took' | 'stopped';
  at: string;
  /** A persona id or `agent:<id>`: who took it (for a stop, who had it). */
  by: string;
  /** What the person was doing when taking it, or the reason it stopped. */
  text: string;
}

/**
 * The moments the head of a card tells that its column entries do not: the
 * person who has it in hand when the column was entered by someone else, and
 * the stop with its reason. A screen that prints the story of the card adds
 * these between the column entries, so the story and the head never differ.
 */
export function cardMoments(card: OrbitCard): CardMoment[] {
  const out: CardMoment[] = [];
  const last = card.history[card.history.length - 1];
  const workerBy = card.worker.kind === 'agent' ? `agent:${card.worker.id}` : card.worker.id;
  if (last && card.worker.kind === 'person' && workerBy !== last.by && card.worker.since > last.at) {
    out.push({ kind: 'took', at: card.worker.since, by: workerBy, text: card.worker.doing });
  }
  if (card.blocked) out.push({ kind: 'stopped', at: card.blocked.since, by: workerBy, text: card.blocked.reason });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** What waits for a person: the cards they must check or approve, not yet done. */
export function waitingFor(cards: OrbitCard[], personaId: string): OrbitCard[] {
  return cards.filter((c) => c.reviewer === personaId && (stageOf(c) === 'verifica' || stageOf(c) === 'approvazione')); // allow-italian: stage and state ids, compared by value
}

/** The slice after moving a card to a column (`by`: a persona id or `agent:<id>`). Moving to the column it is in changes nothing. */
export function withMove(slice: KanbanSlice, card: OrbitCard, stage: StageId, by: string, at: string): KanbanSlice {
  if (stageOf(card) === stage) return slice;
  return { ...slice, moves: { ...slice.moves, [card.id]: [...(slice.moves[card.id] ?? []), { stage, at, by }] } };
}

/** The slice after a person takes a card in hand. */
export function withWorker(slice: KanbanSlice, cardId: string, worker: Worker): KanbanSlice {
  return { ...slice, workers: { ...slice.workers, [cardId]: worker } };
}

/** The slice with a new card (its id must be new). */
export function withCard(slice: KanbanSlice, card: OrbitCard): KanbanSlice {
  return { ...slice, added: [...slice.added, card] };
}

/* ---------- contracts ---------- */

export const CONTRACTS_SLICE = 'orbit.contracts';

export interface ContractsSlice {
  /** Approval steps marked done in the preview, by `<contract>:<step id>`. */
  approvals: Record<string, { at: string; by: string; note?: string }>;
  /** Comments added in the preview. */
  comments: ClauseComment[];
  /** Replies added to existing comments, by comment id. */
  replies: Record<string, Array<{ author: string; at: string; text: string }>>;
  /** Comment ids resolved in the preview. */
  resolved: string[];
  /** Obligation ids closed in the preview, with the proof. */
  obligationsDone: Record<string, { at: string; by: string; proof: string }>;
  /** Versions added in the preview (a new variation's draft), by contract id. */
  versions: Record<string, ContractVersion[]>;
  /** Variations added in the preview, by contract id. */
  variants: Record<string, ContractVariant[]>;
  /** Versions signed in the preview: contract id to version number. */
  signed: Record<string, number>;
  /** Changes asked on an approval step, by `<contract>:<step id>`: the chain starts again from that step. */
  changes?: Record<string, { at: string; by: string; note: string }>;
  /** The receipt of a digital signature made in the preview, by `<contract>:v<version>`. */
  receipts?: Record<string, { at: string; by: string; hash: string; register: string }>;
  /** The approval chain of a variation drafted in the preview, by contract id: it replaces the chain of the fixtures. */
  chains?: Record<string, ApprovalStep[]>;
}

/** The states of a contract before it is signed: signing its last version puts it in force. */
const BEFORE_SIGNATURE: ContractStatus[] = ['bozza', 'revisione', 'approvazione', 'firma']; // allow-italian: values compared by value

export const CONTRACTS_INITIAL: ContractsSlice = { approvals: {}, comments: [], replies: {}, resolved: [], obligationsDone: {}, versions: {}, variants: {}, signed: {} };

export function contractsSlice(state: DemoState): ContractsSlice {
  return { ...CONTRACTS_INITIAL, ...((state.slices[CONTRACTS_SLICE] as Partial<ContractsSlice> | undefined) ?? {}) };
}

/** A contract with the reader's changes applied. */
export function liveContract(contract: Contract, slice: ContractsSlice): Contract {
  const signedN = slice.signed[contract.id];
  const versions = [...contract.versions, ...(slice.versions[contract.id] ?? [])].map((v) => (signedN !== undefined && v.n === signedN ? { ...v, signed: true } : v));
  const resolved = new Set(slice.resolved);
  const comments = [...contract.comments, ...slice.comments.filter((c) => c.id.startsWith(`${contract.id}:`))].map((c) => ({
    ...c,
    resolved: c.resolved || resolved.has(c.id),
    replies: [...(c.replies ?? []), ...(slice.replies[c.id] ?? [])],
  }));
  const approvals = (slice.chains?.[contract.id] ?? contract.approvals).map((s) => {
    const done = slice.approvals[`${contract.id}:${s.id}`];
    return done ? { ...s, state: 'fatto' as const, at: done.at, note: done.note ?? s.note } : s; // allow-italian: stage and state ids, compared by value
  });
  const obligations = contract.obligations.map((o) => (slice.obligationsDone[o.id] ? { ...o, done: true } : o));
  const variants = [...contract.variants, ...(slice.variants[contract.id] ?? [])].map((v) => (signedN !== undefined && v.version === signedN ? { ...v, status: 'firmata' as const } : v));
  const lastN = Math.max(...versions.map((v) => v.n));
  const status: ContractStatus = signedN === lastN && BEFORE_SIGNATURE.includes(contract.status) ? 'attivo' : contract.status; // allow-italian: value compared by value
  return { ...contract, status, versions, comments, approvals, obligations, variants };
}

export function liveContracts(state: DemoState): Contract[] {
  const slice = contractsSlice(state);
  return world().contracts.map((c) => liveContract(c, slice));
}

export function liveContractById(state: DemoState, id: string): Contract | undefined {
  const c = world().contracts.find((x) => x.id === id);
  return c ? liveContract(c, contractsSlice(state)) : undefined;
}
