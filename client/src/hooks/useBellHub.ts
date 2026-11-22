/**
 * What the hub adds to the bell (HUBBR-06, HUBBR-07): the rows of «Ora» that
 * are the hub's, for the button, the Dock and the panel alike (one ledger:
 * the number on the bell is the number of rows the panel lists).
 *
 *   - the live topics (waiting items, services, quotas, alerts) come from
 *     the socket;
 *   - the automations that need you and the broken ones, the contradictions of
 *     the agents' rules and the links to write to Jarvis come from one shared
 *     store (`state/bellExtras`), read when the hub's counters move;
 *   - the Claude proxy's account events come from its log, read in the
 *     background (`state/proxyActivity`): «Ora» lists the urgent ones (an
 *     expired token, every account at its limit), History all of them;
 *   - for the History tab, seven days of the diary (`/api/hub/diario`),
 *     read again every minute while History stays open.
 *
 * Without the hub (never read in this window) nothing is asked: the bell is
 * the Topics inbox of before and the network stays silent (HUBBR-04). With
 * the hub read once and down now, the bell lists Topics alone, and
 * `downSince` says since when.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import { refreshHubLive, useHubEverRead, useHubLive, type HubLiveEntry, type HubLiveState, type HubLiveTopic } from '../state/hubLive';
import { startVisibleInterval } from '../state/documentVisibility';
import { refreshProxyActivity, useProxyActivity } from '../state/proxyActivity';
import { NO_HUB, liveBellHub, urgentAccountEvents, type BellHub } from '../lib/bellGroups';
import { accountEvents, automationSummary, closeWaitingBody, diaryForHistory, type AccountEvent, type DiaryEntry, type JarvisLinks } from '../lib/hubSystem';
import { rereadBellExtras, useBellExtras } from '../state/bellExtras';
import { accountNotes, proxyEvents, type ProxyEvent } from '../lib/proxyEvents';
import { readJson } from '../lib/readJson';

async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const resp = await apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (resp.ok) return null;
    const answer = (await resp.json().catch(() => null)) as { error?: string } | null;
    return answer?.error ?? `HTTP ${resp.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The proxy's account events of the last day, one row per kind and account, with their notes; empty without the hub. */
function useAccountEvents(enabled: boolean): AccountEvent[] {
  const log = useProxyActivity(enabled);
  return useMemo(
    () => (log ? accountEvents(log.activity, log.profiles, log.readAt).map((e) => ({ ...e, notes: accountNotes(e.latest, log.profiles) })) : []),
    [log],
  );
}

/** The proxy's whole log (100 events, a week), described, for History; empty without the hub. */
export function useProxyEvents(enabled: boolean): ProxyEvent[] {
  const log = useProxyActivity(enabled);
  return useMemo(() => (log ? proxyEvents(log.activity, log.profiles) : []), [log]);
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

/** How far back History reads the diary: the hub's own page showed a week. */
const DIARY_DAYS = 7;
/** While History stays open the diary is read again this often, as the hub's page did. */
const DIARY_REFRESH_MS = 60_000;

/** A week of the diary, filtered for the History tab, and when it was read; empty without the hub. */
export function useBellDiary(enabled: boolean): { rows: DiaryEntry[]; readAt: number | null } {
  const present = useHubEverRead();
  const [state, setState] = useState<{ rows: DiaryEntry[]; readAt: number | null }>({ rows: [], readAt: null });
  useEffect(() => {
    if (!enabled || !present) return;
    let alive = true;
    const read = () => {
      void readJson(`/api/hub/diario?days=${DIARY_DAYS}`).then((data) => {
        if (alive && data !== null) setState({ rows: diaryForHistory(data), readAt: Date.now() });
      });
    };
    read();
    const stop = startVisibleInterval(read, DIARY_REFRESH_MS);
    return () => { alive = false; stop(); };
  }, [enabled, present]);
  return enabled && present ? state : { rows: [], readAt: null };
}

/**
 * The writes of the bell: «Done» on a hub item (closed on the hub, then
 * the snapshot is read again so every window drops it), «Fix it» on a
 * failed automation (a job in the hub's queue) and «Renew» on an expired
 * token of the Claude proxy. Each answers null or the reason of the refusal.
 */
export function useBellActions(): {
  closeWaiting: (id: string) => Promise<string | null>;
  fix: (key: string) => Promise<string | null>;
  renew: (profile: string) => Promise<string | null>;
} {
  const closeWaiting = useCallback(async (id: string) => {
    const failure = await post('/api/hub/attesa', closeWaitingBody(id)); // allow-italian: the hub's own path
    if (failure === null) await refreshHubLive();
    return failure;
  }, []);
  const fix = useCallback((key: string) => post('/api/hub/fix', { key }), []);
  // The proxy renews the account's token now (its dashboard's «Refresh token» button).
  // Renewed, the log is read again: the proxy wrote «token renewed» and the row goes.
  const renew = useCallback(async (profile: string) => {
    const failure = await post('/api/switchboard/refresh', { name: profile });
    if (failure === null) await refreshProxyActivity();
    return failure;
  }, []);
  return { closeWaiting, fix, renew };
}

/** «Retry» of the hub-down band: the snapshot read again, which makes the server ask the hub now, and the bell's lists with it. */
export async function retryHub(): Promise<void> {
  await refreshHubLive();
  await rereadBellExtras();
}
