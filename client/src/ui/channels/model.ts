import type { Action, Tone } from '../types';

export type ChannelIconKey = 'pec' | 'mail' | 'whatsapp' | 'teams' | 'telefono' | 'portale' | 'sdi' | 'send';

export interface ChannelRowModel {
  id: string;
  icon: ChannelIconKey;
  name: string;
  /** What comes in and what goes out, already in words. */
  entra: string;
  esce: string;
  /** Items per month, a declared estimate; absent when the channel starts no flow. */
  volume?: number;
  /** Said in place of the number when the channel starts no flow. */
  volumeNote?: string;
  flow: string;
  beforeExit: string;
  state: { label: string; tone: Tone };
  selected: boolean;
  onOpen?: () => void;
}

export interface RoutingRuleModel {
  id: string;
  when: string;
  then: string;
  on: boolean;
  onToggle: Action;
  onDelete: Action;
  /** The flow it starts, to open. */
  onOpenFlow?: () => void;
}

export interface ChannelMessageModel {
  id: string;
  title: string;
  from: string;
  /** Already formatted: `05/11 09:12`. */
  at: string;
  onOpen?: () => void;
}

export interface ChannelReceiptModel {
  id: string;
  title: string;
  at: string;
  lines: string[];
}

export interface ChannelDetailModel {
  id: string;
  icon: ChannelIconKey;
  name: string;
  state: { label: string; tone: Tone };
  provider: string;
  address: string;
  entra: string;
  esce: string;
  volume?: number;
  volumeNote?: string;
  flow: string;
  onOpenFlow?: () => void;
  beforeExit: string;
  policy: string;
  messages: ChannelMessageModel[];
  rules: RoutingRuleModel[];
  receipts: ChannelReceiptModel[];
  /** Why the last attempt to connect failed. */
  error?: string;
}

/** The reader's view of one person reached on several channels (the right side of the overview). */
export interface SamePersonModel {
  name: string;
  items: Array<{ id: string; icon: ChannelIconKey; text: string; at: string; onOpen?: () => void }>;
  note: string;
}
