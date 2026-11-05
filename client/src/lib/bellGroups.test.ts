/**
 * The bell's groups: which rows go where, in which order, and what the button
 * counts. Inputs are the hub's own shapes, trimmed, with placeholder names.
 * @covers HUBBR-06
 * @covers HUBBR-07
 */
import { describe, expect, test } from 'bun:test';
import { BELL_GROUP_ORDER, NO_HUB, bellGroups, bellTimeLabel, hubBadgeCounts, liveBellHub, type BellHub } from './bellGroups';
import { accountEvents, contradictions, diaryForHistory, type WaitingItem } from './hubSystem';
import { bellBadge } from '../state/attentionTotal';
import type { InboxItem } from './inboxModel';
import type { HubLiveState } from '../state/hubLive';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function topicsItem(subject: string, since: number, tier: InboxItem['tier'] = 'needs-you'): InboxItem {
  return {
    subject, kind: 'chat', id: subject, title: subject, project: 'acme-web', since, tier, reason: tier === 'needs-you' ? 'question' : null,
    detail: null, unread: 0, seen: { subject, epoch: 1 } as InboxItem['seen'], url: null, permission: null,
  };
}

function hubItem(id: string, since: number, due: number | null = null): WaitingItem {
  return { id, kind: 'decisione', title: id, why: null, link: null, from: null, due, since };
}

const LIVE: HubLiveState = {
  attesa: { at: 1, data: { items: [{ id: 'spend', tipo: 'spesa', title: 'Move studio-x to the Launch plan', at: NOW - 2 * HOUR, due: NOW + HOUR }] } },
  services: { at: 1, data: { services: [
    { id: 'ok', name: 'Hub', state: 'vivo', problem: null },
    { id: 'off', name: 'Router', state: 'spento', problem: null },
    { id: 'wait', name: 'Free router', state: 'in attesa', problem: null },
    { id: 'docs', name: 'Docs index', state: 'vivo', problem: 'non ascolta su :3342' },
  ] } },
  pace: { at: 1, data: [
    { provider: 'claude', account: 'a', active: true, used: 92, fiveHour: null },
    { provider: 'codex', account: 'b', active: true, used: 85, fiveHour: null },
  ] },
  alerts: { at: 1, data: { firing: [
    { id: 'project:studio-x', subject: 'studio-x', source: 'soglia-progetto', message: 'studio-x: 78% della settimana, budget 60%' },
    { id: 'muse:pace', subject: 'Muse pace', source: 'ritmo-muse', message: 'Ritmo Muse: usato 72%, atteso 43%' },
  ] } },
  automations: { at: 1, data: { needsYou: 0, broken: 2, ok: 80, runsToday: 400 } },
};

describe('HUBBR-06: the groups of the bell', () => {
  test('the five groups in their one order, an empty group not there at all', () => {
    const hub: BellHub = {
      ...liveBellHub(LIVE),
      failed: [{ key: 'gh:docs', title: 'Docs index reindex', at: NOW - HOUR, reason: 'ha fallito alle 21:26' }],
      accounts: [],
      contradictions: [{ id: 'c0', why: 'one says English comments, the other Italian' }],
    };
    const groups = bellGroups({ waiting: [topicsItem('topic:q', NOW - HOUR)], finished: [topicsItem('topic:f', NOW, 'done')] }, hub);
    expect(groups.map((g) => g.key)).toEqual([...BELL_GROUP_ORDER]);
    expect(groups.find((g) => g.key === 'broken')!.entries.map((e) => e.key)).toEqual(['job:gh:docs', 'service:docs']);
    // A project over budget is to look at; the pace of a provider is a quota; only the window at 90% or more enters.
    expect(groups.find((g) => g.key === 'quota')!.entries.map((e) => e.key)).toEqual(['quota:claude:a', 'alert:muse:pace']);
    expect(groups.find((g) => g.key === 'look')!.entries.map((e) => e.key)).toEqual(['alert:project:studio-x', 'c0']);

    const bare = bellGroups({ waiting: [], finished: [topicsItem('topic:f', NOW, 'done')] }, { ...NO_HUB, waiting: [hubItem('x', NOW)] });
    expect(bare.map((g) => g.key)).toEqual(['decide', 'finished']);
  });

  test('«Decide» mixes the waits of Topics and the hub: deadlines first, nearest first, then the longest wait', () => {
    const groups = bellGroups(
      { waiting: [topicsItem('topic:old', NOW - 5 * HOUR), topicsItem('topic:new', NOW - HOUR)], finished: [] },
      { ...NO_HUB, waiting: [hubItem('late', NOW - 3 * HOUR, NOW + 20 * HOUR), hubItem('soon', NOW - HOUR, NOW + HOUR), hubItem('plain', NOW - 9 * HOUR)] },
    );
    expect(groups[0]!.entries.map((e) => e.key)).toEqual(['hub:soon', 'hub:late', 'hub:plain', 'topic:old', 'topic:new']);
  });

  test('without the hub the bell is the Topics inbox of before', () => {
    const groups = bellGroups({ waiting: [topicsItem('topic:q', NOW)], finished: [] }, NO_HUB);
    expect(groups.map((g) => [g.key, g.entries.length])).toEqual([['decide', 1]]);
    expect(hubBadgeCounts({})).toEqual({ decide: 0, alerts: 0 });
    // The hub down: every topic in error, no numbers left.
    expect(hubBadgeCounts({ attesa: { at: 2, error: 'hub not reachable' }, services: { at: 2, error: 'x' } })).toEqual({ decide: 0, alerts: 0 });
  });

  test('the button says the figure of one group: Decidi tu in amber, else the finished in blue, else the warnings in grey', () => {
    // 1 hub decide; alerts: 2 broken + 1 service + 1 full quota + 2 alerts.
    const counts = hubBadgeCounts(LIVE);
    expect(counts).toEqual({ decide: 1, alerts: 6 });
    // 3 lit subjects, 1 of them waiting: the pill is the 2 of Decidi tu, not 3 + 1 + 6.
    expect(bellBadge(3, 1, counts, true)).toEqual({ count: 2, tone: 'needs-you' });
    expect(bellBadge(2, 0, { decide: 0, alerts: 4 }, true)).toEqual({ count: 2, tone: 'lit' });
    expect(bellBadge(0, 0, { decide: 0, alerts: 4 }, true)).toEqual({ count: 4, tone: 'quiet' });
    expect(bellBadge(0, 0, { decide: 0, alerts: 0 }, true)).toEqual({ count: 0, tone: 'quiet' });
  });

  test('without the hub the pill is the number of the Dock (ATTN-08)', () => {
    expect(bellBadge(4, 1, { decide: 0, alerts: 0 }, false)).toEqual({ count: 4, tone: 'needs-you' });
    expect(bellBadge(2, 0, { decide: 0, alerts: 0 }, false)).toEqual({ count: 2, tone: 'lit' });
  });

  test('the time of a row reads like the mockup: adesso, 4 min, the clock, ieri, the date', () => {
    const tr = (key: string, vars?: Record<string, string | number>) => (key === 'bell.time.min' ? `${vars?.n} min` : key === 'bell.time.now' ? 'adesso' : 'ieri');
    const now = new Date(2026, 10, 5, 22, 0).getTime();
    expect(bellTimeLabel(now - 20_000, now, tr)).toBe('adesso');
    expect(bellTimeLabel(now - 4 * 60_000, now, tr)).toBe('4 min');
    expect(bellTimeLabel(new Date(2026, 10, 5, 20, 26).getTime(), now, tr, 'it-IT')).toBe('20:26');
    expect(bellTimeLabel(new Date(2026, 10, 4, 9, 0).getTime(), now, tr)).toBe('ieri');
    expect(bellTimeLabel(new Date(2026, 10, 1, 9, 0).getTime(), now, tr, 'it-IT')).toBe('1 nov');
  });

  test('account events: switches, limits and expired tokens of the last day, one row per kind and account', () => {
    const activity = { log: [
      { type: 'all-exhausted', ts: NOW - 10 * 60_000 },
      { type: 'rate-limited', ts: NOW - 20 * 60_000, account: 'prof-a' },
      { type: 'rate-limited', ts: NOW - 40 * 60_000, account: 'prof-a' },
      { type: 'auto-switch', ts: NOW - 30 * 60_000, from: 'prof-a', to: 'prof-b' },
      { type: 'refresh-failed', ts: NOW - 2 * HOUR, account: 'prof-b' },
      { type: 'token-refreshed', ts: NOW - HOUR, account: 'prof-b' },
      { type: 'auth-expired', ts: NOW - 3 * HOUR, account: 'prof-c' },
      { type: 'upstream-retry', ts: NOW - 5 * 60_000, account: 'prof-a' },
      { type: 'rate-limited', ts: NOW - 30 * HOUR, account: 'prof-c' },
    ] };
    const profiles = { profiles: [{ name: 'prof-a', label: 'work' }, { name: 'prof-b', label: 'spare' }, { name: 'prof-c', label: 'spare-2' }] };
    expect(accountEvents(activity, profiles, NOW).map((e) => [e.kind, e.account, e.to, e.count])).toEqual([
      ['limit', null, null, 1],
      ['limit', 'work', null, 2],
      ['switched', 'work', 'spare', 1],
      ['token', 'spare-2', null, 1],
    ]);
    // «Renew» sends the proxy's own name for the account, never its label.
    expect(accountEvents(activity, profiles, NOW).find((e) => e.kind === 'token')?.profile).toBe('prof-c');
    expect(accountEvents(null, null, NOW)).toEqual([]);
  });

  test('contradictions keep the sentence only, never the files', () => {
    const data = { contradictions: { at: 1, items: [{ a: { file: '~/AGENTS.md', text: 'x' }, b: { file: '~/CLAUDE.md', text: 'y' }, why: 'comments in two languages' }, { why: '' }] } };
    expect(contradictions(data)).toEqual([{ id: 'contradiction-0', why: 'comments in two languages' }]);
  });
});

describe('HUBBR-07: the diary in History', () => {
  test('failed runs, agents, workflows and what you said; never a routine run that went well or was skipped', () => {
    const data = { items: [
      { at: NOW - 1, kind: 'auto', who: 'Mac', title: 'Backup', outcome: 'ok', what: '' },
      { at: NOW - 2, kind: 'auto', who: 'OpenClaw', title: 'Brief', outcome: 'skipped', what: '' },
      { at: NOW - 3, kind: 'auto', who: 'OpenClaw', title: 'Docs reindex', outcome: 'error', what: 'exit 1' },
      { at: NOW - 4, kind: 'app', who: 'Mac', title: 'Delivery', outcome: 'undelivered', what: '' },
      { at: NOW - 5, kind: 'agente', who: 'Agente · Muse', title: 'Fixed the reindex', outcome: 'ok', what: '' },
      { at: NOW - 6, kind: 'workflow', who: 'Workflow', title: 'Dependency audit', outcome: 'ok', what: '' },
      { at: NOW - 7, kind: 'tu', who: 'Tu', title: 'You said «fine»', outcome: null, what: '' },
      { at: NOW - 8, kind: 'boh', title: 'unknown kind' },
      { kind: 'auto', title: 'no time', outcome: 'error' },
    ] };
    expect(diaryForHistory(data).map((d) => d.title)).toEqual(['Docs reindex', 'Delivery', 'Fixed the reindex', 'Dependency audit', 'You said «fine»']);
    expect(diaryForHistory(null)).toEqual([]);
  });
});
