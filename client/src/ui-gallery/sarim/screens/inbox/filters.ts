/**
 * The filters of the to-do page: what the cards can be filtered by, what the search
 * looks in and suggests, and the four saved filters every person finds ready
 * (the ones that stood for the old day page: what waits for me, what is due
 * soon, what is stopped, what the agents hold). The list, the kanban and the
 * table per stage all read the same state (`../../model/dafare.ts`). (allow-italian: quotes the Italian interface)
 */
import { Bot, CalendarDays, CircleDot, CirclePause, FileText, Flag, Hash, MapPin, Scale, User, UserCheck, Workflow, type LucideIcon } from 'lucide-react';
import type { UiCopy } from '../../../../ui/copy/types';
import type { SarimCard, StageId } from '../../../../ui/fixtures/sarim-org/types';
import { world } from '../../world';
import { STAGE_GLYPH } from '../../../../ui/kanban/glyphs';
import type { FilterField, FilterSchema, SavedFilter } from '../../../app/filters';
import { stageOf } from '../../model/live';
import { isStuck } from '../../model/stages';
import { flowLabel, isInAgentHand } from '../../model/flows';
import { dueSoonBefore, FLOW_FIELD, STAGE_FIELD } from '../../model/dafare';
import { STAGE_GLYPH_OF, STAGE_IDS, flowIcon, isOpen, stageLabel, whoName } from './model';

/** The other fields of the filter state (the first two are in `model/dafare.ts`). */
export const WHO_FIELD = 'chi'; // allow-italian: field id of the filter state, compared by value
export const REVIEWER_FIELD = 'verifica'; // allow-italian: field id of the filter state, compared by value
export const DUE_FIELD = 'scadenza'; // allow-italian: field id of the filter state, compared by value
export const PRIORITY_FIELD = 'priorita'; // allow-italian: field id of the filter state, compared by value
export const STUCK_FIELD = 'ferma'; // allow-italian: field id of the filter state, compared by value
export const HAND_FIELD = 'inmano'; // allow-italian: field id of the filter state, compared by value
export const TOWN_FIELD = 'comune'; // allow-italian: field id of the filter state, compared by value
export const CARD_FIELD = 'card';
export const NUMBER_FIELD = 'numero'; // allow-italian: field id of the filter state, compared by value
export const CONTRACT_FIELD = 'contratto'; // allow-italian: field id of the filter state, compared by value

/** The value of the field «Chi ci lavora» that stands for every agent. */
export const ANY_AGENT = 'agents';
export const YES = 'yes';
export const NO = 'no';

/** The value of the field «Chi ci lavora» for a card: the agent or the person, and «any agent» when it is an agent. */
function whoOf(card: SarimCard): string[] {
  return card.worker.kind === 'agent' ? [`agent:${card.worker.id}`, ANY_AGENT] : [card.worker.id];
}

const contractTitle = (id: string | undefined) => world().contracts.find((c) => c.id === id)?.title;

/** The numbers a person types to find a card: those of a report, a booking, an invoice, a user code, read in its detail and its values. */
const NUMBER = /[A-Z]{0,4}-?\d{2,}(?:-\d+)*/g;
export function numbersOf(card: SarimCard): string[] {
  const text = [card.detail, ...card.values.map((v) => v.value)].join(' ');
  return [...new Set(text.match(NUMBER) ?? [])].filter((n) => n.replace(/\D/g, '').length >= 3);
}

/** Everything the search box looks in: the card, its comune, its flow and stage, who works on it and who checks it, its contract and the numbers read on it. */
function searchText(card: SarimCard): string {
  return [
    card.id, card.title, card.detail, card.place ?? '', flowLabel(card.flow), stageLabel(stageOf(card)),
    whoName(card.worker.kind === 'agent' ? `agent:${card.worker.id}` : card.worker.id).full,
    whoName(card.reviewer).full, contractTitle(card.links?.contract) ?? '', ...numbersOf(card),
  ].join(' ');
}

/** The fields of the to-do page. `now` makes the stopped field depend on the demo clock. */
export function todoSchema(copy: UiCopy, now: string): FilterSchema<SarimCard> {
  const f = copy.kanban.filters;
  const person = (id: string): LucideIcon => (id === ANY_AGENT || id.startsWith('agent:') ? Bot : User);
  const fields: Array<FilterField<SarimCard>> = [
    {
      id: FLOW_FIELD, label: f.fields.flow, icon: Workflow, kind: 'choice', get: (c) => c.flow,
      valueLabel: flowLabel, valueIcon: flowIcon, order: world().opsFlows.map((x) => x.id), values: world().opsFlows.map((x) => x.id),
    },
    {
      id: STAGE_FIELD, label: f.fields.stage, icon: CircleDot, kind: 'choice', get: stageOf,
      valueLabel: (v) => stageLabel(v as StageId),
      valueIcon: (v) => STAGE_GLYPH[STAGE_GLYPH_OF[v as StageId]].icon,
      order: STAGE_IDS, values: STAGE_IDS,
    },
    {
      id: WHO_FIELD, label: f.fields.who, icon: User, kind: 'choice', get: whoOf,
      valueLabel: (v) => (v === ANY_AGENT ? f.anyAgent : whoName(v).full), valueIcon: person, order: [ANY_AGENT],
    },
    {
      id: REVIEWER_FIELD, label: f.fields.reviewer, icon: UserCheck, kind: 'choice', get: (c) => c.reviewer,
      valueLabel: (v) => whoName(v).full, valueIcon: () => UserCheck,
    },
    { id: DUE_FIELD, label: f.fields.due, icon: CalendarDays, kind: 'date', get: (c) => (isOpen(c) ? c.due : undefined) },
    {
      id: PRIORITY_FIELD, label: f.fields.priority, icon: Flag, kind: 'choice', get: (c) => c.priority,
      valueLabel: (v) => f.priorities[v as keyof typeof f.priorities] ?? v, order: ['alta', 'normale', 'bassa'], values: ['alta', 'normale', 'bassa'], // allow-italian: priority values, compared by value
    },
    {
      id: STUCK_FIELD, label: f.fields.stuck, icon: CirclePause, kind: 'choice', ops: ['is'],
      get: (c) => (isStuck(c, world().opsFlows, now) ? YES : NO), valueLabel: (v) => (v === YES ? f.yes : f.no), order: [YES, NO], values: [YES, NO],
    },
    {
      // The cards an agent holds, read from the same definition the sidebar and the box of Flussi count by. (allow-italian: quotes the Italian interface)
      id: HAND_FIELD, label: f.fields.inHand, icon: Bot, kind: 'choice', ops: ['is'],
      get: (c) => (isInAgentHand(c) ? YES : NO), valueLabel: (v) => (v === YES ? f.yes : f.no), order: [YES, NO], values: [YES, NO],
    },
    { id: TOWN_FIELD, label: f.fields.town, icon: MapPin, kind: 'choice', get: (c) => c.place },
    { id: CARD_FIELD, label: f.fields.card, icon: FileText, kind: 'text', get: (c) => [c.id, c.title], suggest: true },
    { id: NUMBER_FIELD, label: f.fields.number, icon: Hash, kind: 'text', get: numbersOf, suggest: true },
    { id: CONTRACT_FIELD, label: f.fields.contract, icon: Scale, kind: 'text', get: (c) => contractTitle(c.links?.contract), suggest: true },
  ];
  return { text: searchText, fields };
}

/**
 * The four saved filters that come with the to-do page. The first one is the cards
 * the person must check or approve: the same cards the sidebar counts. The due one
 * has the rule of the deadlines table, late days included: it takes everything due
 * before the eighth day from `today`. The last one reads the field of the cards an
 * agent holds, so its count is `agentsInHand`. (allow-italian: names the Italian saved filters)
 */
export function todoPresets(copy: UiCopy, personaId: string, today: string): SavedFilter[] {
  const s = copy.kanban.filters.saved;
  return [
    {
      id: 'waiting', name: s.waiting,
      tokens: [
        { id: 'p-reviewer', field: REVIEWER_FIELD, op: 'is', value: personaId },
        { id: 'p-check', field: STAGE_FIELD, op: 'is', value: 'verifica' }, // allow-italian: stage id, compared by value
        { id: 'p-approve', field: STAGE_FIELD, op: 'is', value: 'approvazione' }, // allow-italian: stage id, compared by value
      ],
    },
    { id: 'due-soon', name: s.dueSoon, tokens: [{ id: 'p-due', field: DUE_FIELD, op: 'before', value: dueSoonBefore(today) }] },
    { id: 'stuck', name: s.stuck, tokens: [{ id: 'p-stuck', field: STUCK_FIELD, op: 'is', value: YES }] },
    { id: 'agents', name: s.agents, tokens: [{ id: 'p-agents', field: HAND_FIELD, op: 'is', value: YES }] },
  ];
}
