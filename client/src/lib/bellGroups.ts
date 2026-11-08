/**
 * THE BELL'S GROUPS (hub-smistamento, «Campanella»; HUBBR-06). Pure: the
 * inbox model of Topics and the hub's readings in, the groups of the «Now»
 * tab out, in the one order the person reads them:
 *
 *   1. «Decide»: what only the person can do. The waits of Topics
 *      (questions, permissions, plans, reviews) and the hub's «waiting for
 *      you» items, in one list: the ones with a deadline first (the nearest
 *      first), then whoever has waited longest.
 *   2. «Broken»: failed automations, services with a problem or stopped, the
 *      PC that cannot be reached.
 *   3. «Quotas and accounts»: a subscription that runs out before its reset
 *      at today's pace, a window nearly full, a limit reached, an account
 *      switched, a token expired.
 *   4. «To look at»: the Mac under strain, projects over their budget,
 *      contradictions between the agents' rules.
 *   5. «Finished»: as the inbox has always listed them.
 *
 * An empty group is not there at all. Without the hub the hub's parts are
 * empty, so the panel is the Topics inbox of before.
 */
import type { InboxItem } from './inboxModel';
import {
  automationSummary, firingAlerts, quotaLines, servicesDown, waitingItems,
  type AccountEvent, type Contradiction, type FailedJob, type FiringAlert, type QuotaLine, type ServiceDown, type WaitingItem,
} from './hubSystem';
import type { HubLiveState } from '../state/hubLive';
import { machineAlerts, quotaOutlooks, type MachineAlert, type QuotaOutlook } from './hubSignals';

export const BELL_GROUP_ORDER = ['decide', 'broken', 'quota', 'look', 'finished'] as const;
export type BellGroupKey = (typeof BELL_GROUP_ORDER)[number];

/** A hub group shows this many rows, then «N more». */
export const BELL_GROUP_PREVIEW = 5;

/** At or above this share of a window a quota goes in the bell: Topics holds the cards at 90%. */
const QUOTA_BELL_AT = 90;

/** The alert source of a project over its weekly budget: it goes in «To look at», the others are quotas. */
const PROJECT_BUDGET_SOURCE = 'soglia-progetto'; // allow-italian: the hub's wire value

export type BellEntry =
  | { source: 'topics'; key: string; item: InboxItem }
  | { source: 'waiting'; key: string; item: WaitingItem }
  | { source: 'failed'; key: string; job: FailedJob }
  | { source: 'service'; key: string; service: ServiceDown }
  | { source: 'quota'; key: string; quota: QuotaLine }
  | { source: 'outlook'; key: string; outlook: QuotaOutlook }
  | { source: 'machine'; key: string; machine: MachineAlert }
  | { source: 'alert'; key: string; alert: FiringAlert }
  | { source: 'account'; key: string; event: AccountEvent }
  | { source: 'contradiction'; key: string; item: Contradiction };

export interface BellGroup {
  key: BellGroupKey;
  entries: BellEntry[];
}

/** What the hub contributes to the bell; every list empty when there is no hub. */
export interface BellHub {
  waiting: WaitingItem[];
  failed: FailedJob[];
  services: ServiceDown[];
  quotas: QuotaLine[];
  /** The subscriptions that run out before their reset at today's pace. */
  outlooks: QuotaOutlook[];
  /** The Mac under strain, the PC that cannot be reached. */
  machines: MachineAlert[];
  alerts: FiringAlert[];
  accounts: AccountEvent[];
  contradictions: Contradiction[];
}

export const NO_HUB: BellHub = { waiting: [], failed: [], services: [], quotas: [], outlooks: [], machines: [], alerts: [], accounts: [], contradictions: [] };

const isFull = (q: QuotaLine) => q.used >= QUOTA_BELL_AT || (q.fiveHour ?? 0) >= QUOTA_BELL_AT;

/** The parts the live topics carry (no request): waiting items, services, quotas, forecast, machines, alerts. */
export function liveBellHub(live: HubLiveState): Pick<BellHub, 'waiting' | 'services' | 'quotas' | 'outlooks' | 'machines' | 'alerts'> {
  return {
    waiting: waitingItems(live.attesa?.data),
    services: servicesDown(live.services?.data),
    quotas: quotaLines(live.pace?.data).filter(isFull),
    outlooks: quotaOutlooks(live.forecast?.data),
    machines: machineAlerts(live.mac?.data, live.pc?.data),
    alerts: firingAlerts(live.alerts?.data),
  };
}

/** A limit on every account stays news on the button this long; an expired token until it is renewed. */
const URGENT_LIMIT_MS = 3_600_000;

/**
 * The account events that light the button with the panel closed («the facts
 * that matter arrive by themselves»): a token the proxy could not renew (the
 * row offers «Renew») and, for an hour, every account at its limit or cap.
 * A switch, or one account at its limit while another works, is news for the
 * panel, not a reason to call the person.
 */
export function urgentAccountEvents(events: readonly AccountEvent[], now: number): AccountEvent[] {
  return events.filter((e) => e.kind === 'token' || (e.kind === 'limit' && e.account === null && now - e.at < URGENT_LIMIT_MS));
}

/**
 * What the hub adds to the bell's button: the items that wait for the person
 * (they make it amber) and the warnings (grey, with the figure). The live
 * topics, and the proxy's urgent account events (`state/proxyActivity`, read
 * every minute in the background): the failed automations are the summary's
 * counter, the list behind it is read when the panel opens.
 */
export function hubBadgeCounts(live: HubLiveState, accounts: readonly AccountEvent[] = [], now = Date.now()): { decide: number; alerts: number } {
  const parts = liveBellHub(live);
  const broken = automationSummary(live.automations?.data)?.broken ?? 0;
  const urgent = urgentAccountEvents(accounts, now).length;
  return {
    decide: parts.waiting.length,
    alerts: broken + parts.services.length + parts.quotas.length + parts.outlooks.length + parts.machines.length + parts.alerts.length + urgent,
  };
}

/** «Decide»: deadlines first (nearest first), then the longest wait. */
function decideEntries(topics: readonly InboxItem[], hub: readonly WaitingItem[]): BellEntry[] {
  const ranked: { entry: BellEntry; due: number | null; since: number }[] = [
    ...topics.map((item) => ({ entry: { source: 'topics' as const, key: item.subject, item }, due: null, since: item.since })),
    ...hub.map((item) => ({ entry: { source: 'waiting' as const, key: `hub:${item.id}`, item }, due: item.due, since: item.since ?? Number.MAX_SAFE_INTEGER })),
  ];
  return ranked
    .sort((a, b) => {
      if (a.due !== null && b.due !== null) return a.due - b.due;
      if (a.due !== null) return -1;
      if (b.due !== null) return 1;
      return a.since - b.since;
    })
    .map((r) => r.entry);
}

export function bellGroups(model: { waiting: readonly InboxItem[]; finished: readonly InboxItem[] }, hub: BellHub): BellGroup[] {
  const budget = hub.alerts.filter((a) => a.source === PROJECT_BUDGET_SOURCE);
  const pace = hub.alerts.filter((a) => a.source !== PROJECT_BUDGET_SOURCE);
  const groups: BellGroup[] = [
    { key: 'decide', entries: decideEntries(model.waiting, hub.waiting) },
    {
      key: 'broken',
      entries: [
        ...hub.failed.map((job): BellEntry => ({ source: 'failed', key: `job:${job.key}`, job })),
        ...hub.services.map((service): BellEntry => ({ source: 'service', key: `service:${service.id}`, service })),
        ...hub.machines.filter((m) => m.machine === 'pc').map((machine): BellEntry => ({ source: 'machine', key: `machine:${machine.machine}`, machine })),
      ],
    },
    {
      key: 'quota',
      entries: [
        // The forecast first: it says what happens next, the windows nearly full say where it stands.
        ...hub.outlooks.map((outlook): BellEntry => ({ source: 'outlook', key: `outlook:${outlook.provider}`, outlook })),
        ...hub.quotas.map((quota): BellEntry => ({ source: 'quota', key: `quota:${quota.key}`, quota })),
        ...pace.map((alert): BellEntry => ({ source: 'alert', key: `alert:${alert.id}`, alert })),
        ...hub.accounts.map((event): BellEntry => ({ source: 'account', key: `account:${event.key}`, event })),
      ],
    },
    {
      key: 'look',
      entries: [
        ...hub.machines.filter((m) => m.machine === 'mac').map((machine): BellEntry => ({ source: 'machine', key: `machine:${machine.machine}`, machine })),
        ...budget.map((alert): BellEntry => ({ source: 'alert', key: `alert:${alert.id}`, alert })),
        ...hub.contradictions.map((item): BellEntry => ({ source: 'contradiction', key: item.id, item })),
      ],
    },
    { key: 'finished', entries: model.finished.map((item): BellEntry => ({ source: 'topics', key: item.subject, item })) },
  ];
  return groups.filter((g) => g.entries.length > 0);
}

/** The words a time of the bell needs: the panel passes its `tr`, a test a stub. */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MINUTE = 60_000;

/**
 * The time of a row, as the mockup writes it: "now" under a minute, "4 min"
 * under an hour, the clock ("21:26") the same day, "yesterday", then the date.
 */
export function bellTimeLabel(at: number, now: number, tr: Translate, locale?: string): string {
  const ago = now - at;
  if (ago < MINUTE) return tr('bell.time.now');
  if (ago < 60 * MINUTE) return tr('bell.time.min', { n: Math.floor(ago / MINUTE) });
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(at) === day(now - 86_400_000)) return tr('bell.time.yesterday');
  return new Date(at).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
