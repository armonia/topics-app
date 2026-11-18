/**
 * What the tray and the Processes view read about every machine Topics knows:
 * the same shape for this computer, a paired node and a cloud server, so the
 * UI draws one row for all of them. The provider extras exist only for a
 * machine a provider adapter recognises (card 672744e2).
 */

/** One reading of a machine. A field the machine did not measure is null, never 0. */
export interface MachineMetrics {
  cpuPct: number | null;
  memPct: number | null;
  memUsedGB: number | null;
  memTotalGB: number | null;
  diskPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  /** Seconds since boot. */
  uptimeSec: number | null;
  /** OS patches wait for a restart (`/var/run/reboot-required` on Debian-family Linux). Null where the OS has no such signal. */
  rebootRequired: boolean | null;
  cores: number | null;
}

export interface MachineSample {
  t: number;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
}

/** live: answering. stopped: the provider says it is powered off. unreachable: should answer and does not, `reason` says why. */
export type MachineLiveness = 'live' | 'stopped' | 'unreachable';

export interface MachineMoney {
  amount: number;
  currency: string;
}

/** What a provider adapter knows about a machine that the machine cannot say about itself. */
export interface ProviderFacts {
  provider: string;
  providerLabel: string;
  monthly: MachineMoney | null;
  /** Cost accrued in the current calendar month. */
  spentThisMonth: MachineMoney | null;
  location: string | null;
  serverType: string | null;
  /** Epoch ms of the provider's last power-on, when it tells. */
  createdAt: number | null;
}

/**
 * What one agent is doing, from the person's side. Order of the list is the
 * order of attention: waiting for you, working, stuck on a limit, in review, queued.
 * `chat` is an open turn of a conversation (not a board card).
 */
export type MachineAgentState = 'waiting' | 'working' | 'chat' | 'stuck' | 'review' | 'queued';

export interface MachineAgentItem {
  /** The card's or chat's title, shortened for a tray row: never an id, a branch or a file name. */
  title: string;
  /** Visible project name; a fixed placeholder label when the work belongs to none. */
  project: string;
  state: MachineAgentState;
  /** Epoch ms the agent entered this state; null when nothing records it. */
  since: number | null;
}

/** The agents a machine carries. Cards count by derived state; chats are open turns of this machine's native engine. */
export interface MachineAgents {
  /** In progress with a live turn. */
  working: number;
  /** Waiting for a person: a question on the card, a review with an ask, or a chat parked on a question. */
  waiting: number;
  /** In review with nothing asked of the person. */
  review: number;
  /** Stopped on a plan limit (Claude/Codex window or spent plan). */
  stuck: number;
  /** Todo, or waiting for a slot / a declared condition. */
  queued: number;
  /** In progress but with no live turn behind it (the creating chat is idle): counted, never listed. */
  idle: number;
  /** Chats with a turn open right now (separate from the cards). */
  chats: number;
  byProject: Array<{ project: string; count: number }>;
  /** At most 12; a review older than 7 days is counted above and left out here. */
  items: MachineAgentItem[];
}

export interface MachineOverviewRow {
  id: string;
  name: string;
  local: boolean;
  platform: string;
  state: MachineLiveness;
  /** Machine-readable cause when the state is not live: not_paired, unreachable, http_<status>, not_a_node, powered_off. */
  reason: string | null;
  metrics: MachineMetrics | null;
  history: MachineSample[];
  /** Null on a machine no adapter recognises: it is the owner's own. */
  provider: ProviderFacts | null;
  /** The provider could not be read (no token, API down); the row keeps its gauges. */
  providerError: string | null;
  /** What runs on this machine. Absent on a payload from a server that predates it. */
  agents?: MachineAgents;
  at: number;
}

export interface MachineOverview {
  machines: MachineOverviewRow[];
  /** Adapters with their token state, so Settings can offer the field. */
  providers: Array<{ id: string; label: string; configured: boolean }>;
}
