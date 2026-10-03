/**
 * WHAT A ROW THAT OPENS A FORM SAYS BEFORE YOU OPEN IT.
 *
 * Plan, AI providers, tools, calendar and machines used to be pages of a
 * Settings window, and the only way to learn "which plan am I on" or "is the
 * calendar connected" was to open it and read. Now each lives where it is used
 * (SETHOME-01): the plan and the machines in the user menu, the providers at the
 * foot of the model selector, the tools in the composer's «+», the calendar in
 * its tile's menu. The row that opens each answers the common question in its
 * tail, the way «View» already says the order of the column.
 *
 * Pure on purpose. The surfaces fetch the facts while they are open and hand
 * them here; what a fact becomes on screen is the part that can be wrong in silence
 * (a free plan announced as a team, a subscription label made up from a field
 * we do not understand), so it is the part with tests (`formLevelTails.test.ts`).
 */
import type { McpFleetStatus } from '../../../../shared/session-environment';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from '../../types';
import { giorniAllaScadenza, scadenzaVicina } from '../Settings/pianoState';
import { PLAN_USAGE_WARN_AT } from '../../../../shared/provider-hold';

import type { Translate } from '../../../../shared/queue-reason-text';

/** The three facts of `/api/license` the Plan tail reads. */
export interface LicensePlan {
  plan: 'free' | 'team';
  seats: number;
  /** ms epoch, `null` on the free plan. */
  expiresAt: number | null;
}

/** A tail: the words, and whether they ask for attention. */
export interface Tail {
  text: string;
  warn: boolean;
}

/**
 * THE TOPICS PLAN, and its expiry when it is close enough to name.
 *
 * «Free» and «Team · 5 seats». The expiry leads it only inside the same thirty days
 * the Plan level itself uses (`scadenzaVicina`): a countdown that starts a year
 * out is noise, and noise teaches people not to read the tail at all.
 */
export function planTail(plan: LicensePlan | null, now: number, tr: Translate): Tail | null {
  if (!plan) return null;
  const base = plan.plan === 'team'
    ? (plan.seats === 1 ? tr('userMenu.plan.teamOne') : tr('userMenu.plan.team', { n: plan.seats }))
    : tr('userMenu.plan.free');
  if (!scadenzaVicina(plan.expiresAt, now)) return { text: base, warn: false };
  const days = giorniAllaScadenza(plan.expiresAt, now) ?? 0;
  const expiry = days < 0
    ? tr('userMenu.plan.expired')
    : days === 0 ? tr('userMenu.plan.expiresToday') : tr('userMenu.plan.expiresIn', { n: days });
  // The warning LEADS: the tail truncates at its right end, and in a 288 px
  // menu the seats pushed the expiry past it. What is cut now is the seats.
  return { text: `${expiry} · ${base}`, warn: true };
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

/** The providers that run on a Claude subscription, whose plan the tail may name:
 *  the claude CLI and `topics`, the default runtime, which signs in with the
 *  same credentials (`DEFAULT_AGENT_RUNTIME`). */
const CLAUDE_SUBSCRIPTION_PROVIDERS = new Set(['claude-code', 'topics']);

/**
 * THE CLAUDE PLAN OF THIS MACHINE, from whichever Claude row carries it.
 *
 * Both rows read the same credentials, so either one is the answer; reading
 * only `claude-code` lost the plan on a machine without the claude CLI, where
 * `topics` is signed in all the same. Null when no Claude row has one (an API
 * key, no login): there is no subscription to speak of.
 */
export function claudeSubscription(snapshot: ProvidersSnapshot | null): ProviderSnapshotEntry['subscription'] | null {
  if (!snapshot) return null;
  return snapshot.providers.find((p) => CLAUDE_SUBSCRIPTION_PROVIDERS.has(p.name) && p.subscription)?.subscription ?? null;
}

/**
 * THE PROVIDERS ROW OF A MODEL SELECTOR: how many can run a turn right now, or
 * the one problem that matters, which is the provider this selector has chosen
 * not being ready: "3 ready"; "Codex not ready" in the warning tone; "None
 * ready" when nothing can run. `topics` is not counted: it is the routing
 * switch above the list, not a provider of its own (AICTRL-01).
 */
export function providersReadyTail(snapshot: ProvidersSnapshot | null, chosen: string | null, tr: Translate): Tail | null {
  if (!snapshot) return null;
  const chosenRow = chosen ? snapshot.providers.find((p) => p.name === chosen) : undefined;
  if (chosenRow && chosenRow.status !== 'ready') {
    return { text: tr('home.providers.notReady', { name: chosenRow.label ?? chosenRow.name }), warn: true };
  }
  const ready = snapshot.providers.filter((p) => p.name !== 'topics' && p.status === 'ready').length;
  if (ready === 0) return { text: tr('home.providers.noneReady'), warn: true };
  return { text: ready === 1 ? tr('home.providers.readyOne') : tr('home.providers.ready', { n: ready }), warn: false };
}

/** Is this provider one whose models run on the Claude subscription? */
export function runsOnClaudePlan(provider: string | null | undefined): boolean {
  return !!provider && CLAUDE_SUBSCRIPTION_PROVIDERS.has(provider);
}

/**
 * THE CLAUDE PLAN IN ONE SHORT LINE, beside the Claude models of a selector:
 * «Max 20x · 5 h al 42%». The plan alone without a reading, the reading alone
 * without a known plan, nothing with neither.
 */
export function claudePlanCompact(
  sub: ProviderSnapshotEntry['subscription'] | null | undefined,
  fiveHour: { utilization: number } | null | undefined,
  tr: Translate,
  sevenDay?: { utilization: number } | null,
): Tail | null {
  const plan = subscriptionLabel(sub);
  const usage = fiveHour ? tr('home.claudeUsage', { pct: Math.round(fiveHour.utilization) }) : null;
  // The week after the five hours (CMDUI-05): its block stops work for days,
  // and the figure arrives with the same reading.
  const week = sevenDay ? tr('home.claudeWeek', { pct: Math.round(sevenDay.utilization) }) : null;
  const parts = [plan, usage, week].filter((p): p is string => !!p);
  if (!plan && !usage && !week) return null;
  const text = parts.join(' · ');
  const warn = (!!fiveHour && fiveHour.utilization >= PLAN_USAGE_WARN_AT) || (!!sevenDay && sevenDay.utilization >= PLAN_USAGE_WARN_AT);
  return { text, warn };
}

/** How many MCP servers are mounted and answering. A fleet never mounted (or
 *  mounting now) says nothing: its empty list is "not asked yet", not "none". */
export function toolsTail(fleet: (Pick<McpFleetStatus, 'enabled' | 'servers'> & Partial<Pick<McpFleetStatus, 'mounting' | 'mounted'>>) | null, tr: Translate): string | null {
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

/** The badge's words for requests from other nodes, singular for one. */
export function nodeRequestsLabel(n: number, tr: Translate): string {
  return n === 1 ? tr('userMenu.nodes.requestOne') : tr('userMenu.nodes.requests', { n });
}

/**
 * THE FIVE-HOUR WINDOW, next to the plan it belongs to: «5 h: 42% · resets
 * 20:49». The plan and how much of it is spent read together, inside the
 * AI providers level. Null without a reading.
 */
/**
 * «Week at 78% · resets Sat 13:00» (CMDUI-05). The day is said too: a weekly
 * reset named by its hour alone is a different day to every reader.
 */
export function weekUsageLine(
  window: { utilization: number; resetsAtMs: number | null } | null,
  formatDayTime: (ms: number) => string,
  tr: Translate,
): string | null {
  if (!window) return null;
  const pct = Math.round(window.utilization);
  return window.resetsAtMs === null
    ? tr('userMenu.usage.week', { pct })
    : tr('userMenu.usage.weekReset', { pct, when: formatDayTime(window.resetsAtMs) });
}

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
