/**
 * WHAT THE FIVE FORM ROWS OF THE USER MENU SAY WITH THEIR LEVEL CLOSED.
 *
 * Plan, AI providers, tools, calendar and nodes used to be pages of a Settings
 * window, and the only way to learn "which plan am I on" or "is the calendar
 * connected" was to open it and read. Now they are levels of the user menu, and
 * the row answers the common question in its tail, the way «View» already says
 * the order of the column: the level is for changing it.
 *
 * Pure on purpose. The menu fetches the facts while it is open and hands them
 * here; what a fact becomes on screen is the part that can be wrong in silence
 * (a free plan announced as a team, a subscription label made up from a field
 * we do not understand), so it is the part with tests (`formLevelTails.test.ts`).
 */
import type { McpFleetStatus } from '../../../../shared/session-environment';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from '../../types';
import { giorniAllaScadenza, scadenzaVicina, type StatoPiano } from '../Settings/pianoState';

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A tail: the words, and whether they ask for attention. */
export interface Tail {
  text: string;
  warn: boolean;
}

/**
 * THE TOPICS PLAN, and its expiry when it is close enough to name.
 *
 * «Free» and «Team · 5 seats». The expiry joins only inside the same thirty days
 * the Plan level itself uses (`scadenzaVicina`): a countdown that starts a year
 * out is noise, and noise teaches people not to read the tail at all.
 */
export function planTail(plan: Pick<StatoPiano, 'plan' | 'seats' | 'expiresAt'> | null, now: number, tr: Translate): Tail | null {
  if (!plan) return null;
  const base = plan.plan === 'team'
    ? (plan.seats === 1 ? tr('userMenu.plan.teamOne') : tr('userMenu.plan.team', { n: plan.seats }))
    : tr('userMenu.plan.free');
  if (!scadenzaVicina(plan.expiresAt, now)) return { text: base, warn: false };
  const days = giorniAllaScadenza(plan.expiresAt, now) ?? 0;
  const expiry = days < 0
    ? tr('userMenu.plan.expired')
    : days === 0 ? tr('userMenu.plan.expiresToday') : tr('userMenu.plan.expiresIn', { n: days });
  return { text: `${base} · ${expiry}`, warn: true };
}

/**
 * THE CLAUDE SUBSCRIPTION AS A PERSON NAMES IT.
 *
 * The server passes two labels the CLI writes next to its tokens
 * (`subscriptionType`, `rateLimitTier`). `max` alone does not say which Max:
 * the tier does (`default_claude_max_20x`). A type this function does not know
 * says NOTHING rather than its raw id: a tail reading «enterprise_v2» would be
 * a guess dressed as a fact.
 */
export function subscriptionLabel(sub: ProviderSnapshotEntry['subscription'] | null | undefined): string | null {
  if (!sub?.type) return null;
  switch (sub.type.toLowerCase()) {
    case 'pro': return 'Pro';
    case 'team': return 'Team';
    case 'enterprise': return 'Enterprise';
    case 'max': {
      const multiple = /(?:^|_)(\d+)x(?:$|_)/i.exec(sub.tier ?? '')?.[1];
      return multiple ? `Max ${multiple}x` : 'Max';
    }
    default: return null;
  }
}

/** The providers that run on a Claude subscription, whose plan the tail may name. */
const CLAUDE_SUBSCRIPTION_PROVIDERS = new Set(['claude-code']);

/** The default provider's row, and the Claude plan when that row runs on it. */
export function providersTail(snapshot: ProvidersSnapshot | null, tr: Translate): string | null {
  if (!snapshot) return null;
  const name = snapshot.defaultProvider;
  if (!name) return tr('userMenu.none');
  const row = snapshot.providers.find((p) => p.name === name);
  const label = row?.label ?? name;
  const plan = row && CLAUDE_SUBSCRIPTION_PROVIDERS.has(row.name) ? subscriptionLabel(row.subscription) : null;
  return plan ? `${label} · ${plan}` : label;
}

/** How many MCP servers are mounted and answering. A fleet never mounted (or
 *  mounting now) says nothing: its empty list is "not asked yet", not "none". */
export function toolsTail(fleet: Pick<McpFleetStatus, 'enabled' | 'servers' | 'mounting' | 'mounted'> | null, tr: Translate): string | null {
  if (!fleet) return null;
  if (!fleet.enabled) return tr('userMenu.tools.off');
  if (fleet.mounting || fleet.mounted === false) return null;
  const ready = fleet.servers.filter((s) => s.state === 'ready').length;
  if (ready === 0) return tr('userMenu.none');
  return ready === 1 ? tr('userMenu.tools.one') : tr('userMenu.tools.many', { n: ready });
}

/** The calendar feed, in the three states the Calendar level already knows. */
export function calendarTail(settings: { calendarFeedUrl?: string | null; calendarEnabled?: boolean | null } | null, tr: Translate): string | null {
  if (!settings) return null;
  if (!settings.calendarFeedUrl) return tr('userMenu.calendar.none');
  return settings.calendarEnabled === true ? tr('userMenu.calendar.on') : tr('userMenu.calendar.paused');
}

/** How many nodes this board spans (the local machine is not one). */
export function nodesTail(nodes: number | null, tr: Translate): string | null {
  if (nodes === null) return null;
  if (nodes === 0) return tr('userMenu.none');
  return nodes === 1 ? tr('userMenu.nodes.one') : tr('userMenu.nodes.many', { n: nodes });
}

/**
 * THE FIVE-HOUR WINDOW, next to the plan it belongs to: «5 h: 42% · resets
 * 20:49». The plan and how much of it is spent read together, inside the
 * AI providers level. Null without a reading.
 */
export function usageLine(
  window: { utilization: number; resetsAtMs: number | null } | null,
  formatTime: (ms: number) => string,
  tr: Translate,
): string | null {
  if (!window) return null;
  const pct = Math.round(window.utilization);
  return window.resetsAtMs === null
    ? tr('userMenu.usage.fiveHours', { pct })
    : tr('userMenu.usage.fiveHoursReset', { pct, time: formatTime(window.resetsAtMs) });
}
