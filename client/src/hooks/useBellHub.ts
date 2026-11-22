/**
 * What the hub adds to the bell (HUBBR-06, HUBBR-07): the rows of «Ora» that
 * are the hub's, for the button, the Dock and the panel alike (one ledger:
 * the number on the bell is the number of rows the panel lists). It runs in
 * its own chunk, through `BellHubSource`, so the hub's parsers stay out of
 * the first download.
 *
 *   - the live topics (waiting items, services, quotas, alerts) come from
 *     the socket;
 *   - the automations that need you and the broken ones, the contradictions of
 *     the agents' rules and the links to write to Jarvis come from one shared
 *     store (`state/bellExtras`), read when the hub's counters move;
 *   - the Claude proxy's account events come from its log, read in the
 *     background (`state/proxyActivity`): «Ora» lists the urgent ones (an
 *     expired token, every account at its limit), History all of them;
 *   - History's reads and the rows' writes live in `useBellPanel`, which
 *     travels with the panel's lazy chunk, not with the first download.
 *
 * Without the hub (never read in this window) nothing is asked: the bell is
 * the Topics inbox of before and the network stays silent (HUBBR-04). With
 * the hub read once and down now, the bell lists Topics alone, and
 * `downSince` says since when.
 */
import { useMemo } from 'react';
import { useHubEverRead, useHubLive, type HubLiveEntry, type HubLiveState, type HubLiveTopic } from '../state/hubLive';
import { useProxyActivity } from '../state/proxyActivity';
import { NO_HUB, liveBellHub, urgentAccountEvents, type BellHub } from '../lib/bellGroups';
import { accountEvents, automationSummary, type AccountEvent, type JarvisLinks } from '../lib/hubSystem';
import { useBellExtras } from '../state/bellExtras';

/**
 * The proxy's account events of the last day, one row per kind and account;
 * empty without the hub. Their notes (how it happened) are read by the row
 * that shows them, in the panel's chunk: the count needs only the events.
 */
function useAccountEvents(enabled: boolean): AccountEvent[] {
  const log = useProxyActivity(enabled);
  return useMemo(() => (log ? accountEvents(log.activity, log.profiles, log.readAt) : []), [log]);
}

/** The live topics the bell lists from: one that errs while the others answer was not read, not empty. */
const BELL_TOPICS: readonly HubLiveTopic[] = ['attesa', 'services', 'alerts', 'pace']; // allow-italian: hub topic names

/** The bell's topics that failed while the hub answers on others: «not read», never «nothing». */
export function unreadTopics(live: HubLiveState): HubLiveTopic[] {
  if (!Object.values(live).some((e) => e?.data !== undefined)) return [];
  return BELL_TOPICS.filter((t) => live[t]?.error !== undefined);
}

/** Since when the hub has not answered: the oldest error of the live topics, null while one answers. */
function downSinceOf(live: HubLiveState): number | null {
  const entries = Object.values(live).filter((e): e is HubLiveEntry => !!e);
  if (entries.length === 0 || entries.some((e) => e.data !== undefined)) return null;
  return Math.min(...entries.map((e) => e.at));
}

/**
 * The hub's part of the bell. `present`: the hub was read in this window (it
 * is part of the installation); `answering`: it answers now (some live topic
 * carries data), what the foot of the panel says; `downSince`: when it
 * stopped, while it does not.
 */
export function useBellHub(): { hub: BellHub; present: boolean; answering: boolean; downSince: number | null; unread: HubLiveTopic[]; jarvis: JarvisLinks | null } {
  const live = useHubLive();
  const present = useHubEverRead();
  const summary = automationSummary(live.automations?.data);
  const answering = present && Object.values(live).some((entry) => entry?.data !== undefined);
  const extras = useBellExtras(answering, summary ? `${summary.needsYou}:${summary.broken}` : null);
  const accounts = useAccountEvents(present);
  const readAt = useProxyActivity(present)?.readAt;

  // Down, the bell is Topics alone: what the hub said is as old as its silence.
  const hub = useMemo((): BellHub => (answering
    ? { ...liveBellHub(live), failed: extras.failed, automations: extras.automations, contradictions: extras.contradictions, accounts: readAt !== undefined ? urgentAccountEvents(accounts, readAt) : [] }
    : NO_HUB), [answering, live, extras, accounts, readAt]);
  // One object per change, not per render: the Dock's ledger is memoised on it.
  const downSince = present ? downSinceOf(live) : null;
  const unreadKey = answering ? unreadTopics(live).join(',') : '';
  const jarvis = answering ? extras.jarvis : null;
  return useMemo(() => ({
    hub, present, answering, downSince,
    unread: unreadKey ? (unreadKey.split(',') as HubLiveTopic[]) : [], jarvis,
  }), [hub, present, answering, downSince, unreadKey, jarvis]);
}
