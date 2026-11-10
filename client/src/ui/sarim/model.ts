import type { Tone } from '../types';

/** One row of the call center's list: an item to handle, or a call. */
export interface CallRowModel {
  id: string;
  title: string;
  summary?: string;
  chip?: { text: string; tone: Tone };
  /** «4 min», «scaduta», «oggi 10:02». */
  when: string;
  overdue?: boolean;
  selected: boolean;
}

/** The call that rings now, drawn as a card at the head of the list. */
export interface IncomingCallModel {
  id: string;
  caller: string;
  status: 'ringing' | 'live' | 'ended';
  selected: boolean;
}

/** An item of the queue with the words of the service proposed for it. */
export interface TicketModel {
  id: string;
  title: string;
  asked: { text: string; source: string };
  service: { turn: string; site: string; vehicle: string; notice: string };
  turnOptions: Array<{ value: string; label: string }>;
  checked: string[];
  events: Array<{ id: string; at: string; what: string }>;
  /** Set once the service is confirmed: the receipt of what left the system. */
  receipt?: { title: string; lines: string[] };
  /** A simulated action in progress on this item. */
  running?: { label: string; progress: number };
}

export interface CallFieldModel {
  id: string;
  label: string;
  value: string;
  /** Filled by the AI from what was heard (a field not filled yet is drawn as waiting). */
  filled: boolean;
  error?: string;
}

export interface AddressCheckModel {
  tone: 'ok' | 'warn' | 'idle';
  title: string;
  body: string;
  /** Streets the index suggests when the address is not found. */
  suggestions: string[];
}

export interface CallModel {
  id: string;
  caller: string;
  when: string;
  status: 'ringing' | 'live' | 'ended';
  lines: Array<{ id: string; who: 'operator' | 'caller'; text: string }>;
  totalLines: number;
  /** The line label of the step being heard, while live. */
  progress: number;
  fields: CallFieldModel[];
  address: AddressCheckModel;
  /** The item this call ended in, when there is one. */
  ticketId?: string;
  /** Opening is in progress: the steps of the job. */
  opening?: { label: string; progress: number };
}
