/**
 * What the call center remembers (`ctx.slice('sarim')`): which calls were
 * answered, what the operator corrected in a form, the reports opened from a
 * call, and what was done to each item of the queue. The seeds themselves
 * (`fixtures/sarim.ts`) never change.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { AddressCheckModel, CallFieldModel, CallModel } from '../../../../ui/sarim/model';
import {
  FIELD_ORDER, INCOMING_CALL, QUEUE, RECENT_CALLS, STREET_INDEX, defaultService, orderNumber,
  type CallField, type CallSeed, type QueueItemSeed,
} from '../../../../ui/fixtures/sarim';

export interface ItemState {
  status: 'open' | 'confirmed';
  service?: Partial<QueueItemSeed['service']>;
  events: Array<{ id: string; at: string; what: string }>;
  receipt?: { title: string; lines: string[] };
  /** Times the customer was called back without an answer. */
  noAnswer?: number;
}

export interface SarimState {
  answered: string[];
  forms: Record<string, Partial<Record<CallField, string>>>;
  /** Reports opened from a call, after the four of the queue. */
  tickets: QueueItemSeed[];
  items: Record<string, ItemState>;
  /** The report opened from a call that was not in the seed. */
  callTicket: Record<string, string>;
  /** Failed «open report» attempts, so the first one of a call can fail once. */
  seq: number;
}

export const SARIM_INITIAL: SarimState = { answered: [], forms: {}, tickets: [], items: {}, callTicket: {}, seq: 1 };

export const allItems = (st: SarimState): QueueItemSeed[] => [...QUEUE, ...st.tickets];
export const itemState = (st: SarimState, id: string): ItemState => st.items[id] ?? { status: 'open', events: [] };
export const isOpen = (st: SarimState, id: string) => itemState(st, id).status !== 'confirmed';
export const openItems = (st: SarimState) => allItems(st).filter((i) => isOpen(st, i.id));
export const findItem = (st: SarimState, id: string) => allItems(st).find((i) => i.id === id);
export const allCalls = (): CallSeed[] => [INCOMING_CALL, ...RECENT_CALLS];
export const findCall = (id: string) => allCalls().find((c) => c.id === id);

/** The item with the operator's corrections applied. */
export function liveService(st: SarimState, item: QueueItemSeed): QueueItemSeed['service'] {
  return { ...item.service, ...itemState(st, item.id).service };
}

/** What the form holds after the first `heard` lines, with the operator's corrections on top. */
export function callValues(st: SarimState, call: CallSeed, heard: number): Partial<Record<CallField, string>> {
  const out: Partial<Record<CallField, string>> = {};
  for (const line of call.transcript.slice(0, heard)) Object.assign(out, line.fills);
  return { ...out, ...st.forms[call.id] };
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');

/** Checks the address of a call against the street index (the municipality's, in the product). */
export function checkAddress(values: Partial<Record<CallField, string>>, copy: UiCopy): AddressCheckModel {
  const c = copy.orgs.callCenter.address;
  const street = norm(values.street ?? '');
  const city = norm(values.city ?? '');
  const number = Number.parseInt(values.number ?? '', 10);
  if (!street) return { tone: 'idle', title: c.waiting, body: c.waitingBody, suggestions: [] };
  const hit = STREET_INDEX.find((s) => norm(s.street) === street && (!city || norm(s.city) === city));
  if (hit) {
    if (Number.isFinite(number) && number >= 1 && number <= hit.max) {
      return { tone: 'ok', title: c.found, body: c.foundBody(hit.street, number, hit.city), suggestions: [] };
    }
    return { tone: 'warn', title: c.checkNumber, body: c.checkNumberBody(hit.street, hit.max), suggestions: [] };
  }
  const near = STREET_INDEX
    .filter((s) => !city || norm(s.city) === city || norm(s.street).split(' ').some((w) => w.length > 2 && street.includes(w)))
    .slice(0, 3)
    .map((s) => s.street);
  return { tone: 'warn', title: c.notFound, body: c.notFoundBody(values.street ?? ''), suggestions: near };
}

export interface CallViewOptions {
  /** Lines heard so far while live; undefined: all (ended) or none (ringing). */
  heard?: number;
  status: CallModel['status'];
  progress?: number;
  showErrors?: boolean;
  opening?: CallModel['opening'];
}

export function callModel(st: SarimState, call: CallSeed, copy: UiCopy, opt: CallViewOptions): CallModel {
  const c = copy.orgs.callCenter;
  const total = call.transcript.length;
  const heard = opt.status === 'ended' ? total : opt.status === 'live' ? opt.heard ?? 0 : 0;
  const values = callValues(st, call, heard);
  const fields: CallFieldModel[] = FIELD_ORDER.map((id) => {
    const value = values[id] ?? '';
    const required = id === 'kind' || id === 'street';
    return {
      id,
      label: c.fields[id],
      value,
      filled: Boolean(value),
      error: opt.showErrors && required && !value ? c.requiredField : undefined,
    };
  });
  return {
    id: call.id,
    caller: call.caller,
    when: call.at,
    status: opt.status,
    lines: call.transcript.slice(0, heard).map((l, i) => ({ id: `${call.id}-${i}`, who: l.who, text: l.text })),
    totalLines: total,
    progress: opt.progress ?? (heard / Math.max(total, 1)),
    fields,
    address: checkAddress(values, copy),
    ticketId: call.ticket ?? st.callTicket[call.id],
    opening: opt.opening,
  };
}

/** The item a report opened from a call becomes: the proposal comes from rules, the words of the customer from the transcript. */
export function ticketFromCall(st: SarimState, call: CallSeed, copy: UiCopy): QueueItemSeed {
  const c = copy.orgs.callCenter;
  const values = callValues(st, call, call.transcript.length);
  const n = st.seq;
  const service = defaultService(values.kind ?? '', values.city ?? '');
  const where = [values.street, values.number].filter(Boolean).join(' ');
  const address = checkAddress(values, copy);
  return {
    id: `s-${n}`,
    title: [values.kind, where, values.city].filter(Boolean).join(', ') + ` ${c.exampleTag}`,
    summary: c.proposalLine(service.turn),
    chip: { text: c.channelCall, tone: 'neutral' },
    ageMin: 0,
    asked: {
      text: call.transcript.filter((l) => l.who === 'caller').map((l) => l.text).join(' '),
      source: c.callSource(call.caller),
    },
    service,
    checked: [address.title, c.noDuplicates],
    order: orderNumber(n),
  };
}
