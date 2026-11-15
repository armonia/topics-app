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
  at: number;
}

export interface MachineOverview {
  machines: MachineOverviewRow[];
  /** Adapters with their token state, so Settings can offer the field. */
  providers: Array<{ id: string; label: string; configured: boolean }>;
}
