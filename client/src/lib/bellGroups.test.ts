/**
 * The bell's groups: which rows go where, in which order, and what the button
 * counts. Inputs are the hub's own shapes, trimmed, with placeholder names.
 * @covers HUBBR-06
 * @covers HUBBR-07
 */
import { describe, expect, test } from 'bun:test';
import { BELL_GROUP_ORDER, NO_HUB, bellGroups, bellTimeLabel, bellTone, bellTotal, liveBellHub, urgentAccountEvents, type BellHub } from './bellGroups';
import { accountNotes } from './proxyEvents';
import { accountEvents, contradictions, diaryForHistory, type WaitingItem } from './hubSystem';
import { automationWaitsOf } from './hubGates';
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
  return { id, kind: 'decisione', title: id, why: null, link: null, automationKey: null, place: null, from: null, due, since };
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
      automations: [],
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

  test('the forecast and the machines: a subscription that runs out is the first quota row, the PC unreachable is broken, the Mac under strain is to look at', () => {
    const live: HubLiveState = {
      ...LIVE,
      forecast: { at: 1, data: { providers: [
        { id: 'codex', status: 'stretto', level: 1, right: 'regge fino a ven 18:00', sub: 'poi 10 h senza', soon: false },
        { id: 'claude', status: 'corto', level: 2, right: 'finisce domani alle 04:46', sub: '3 account · al ritmo di oggi', soon: true },
        { id: 'muse', status: 'ok', level: 0, right: 'arriva al reset', sub: null, soon: false },
      ] } },
      mac: { at: 1, data: { effort: { level: 2, label: 'sotto sforzo', why: 'disco al 97%' } } },
      pc: { at: 1, data: { pc: 'chiuso' } },
    };
    const parts = liveBellHub(live);
    // The worst first; a provider that reaches its reset is not news.
    expect(parts.outlooks.map((o) => [o.provider, o.tone])).toEqual([['claude', 'bad'], ['codex', 'warn']]);
    expect(parts.machines).toEqual([
      { machine: 'mac', state: 'sotto sforzo', why: 'disco al 97%', tone: 'bad' },
      { machine: 'pc', state: 'closed', why: null, tone: 'warn' },
    ]);
    const groups = bellGroups({ waiting: [], finished: [] }, { ...NO_HUB, ...parts });
    expect(groups.find((g) => g.key === 'quota')!.entries.map((e) => e.key)).toEqual(['outlook:claude', 'outlook:codex', 'quota:claude:a', 'alert:muse:pace']);
    expect(groups.find((g) => g.key === 'broken')!.entries.map((e) => e.key)).toEqual(['service:docs', 'machine:pc']);
    expect(groups.find((g) => g.key === 'look')!.entries.map((e) => e.key)).toEqual(['machine:mac', 'alert:project:studio-x']);
    // The number is the rows: 1 wait + 2 broken + 4 quotas + 2 to look at.
    expect(bellTotal(groups)).toBe(groups.reduce((n, g) => n + g.entries.length, 0));
    // A PC asleep or at work, a Mac only busy: nothing to say.
    expect(liveBellHub({ mac: { at: 1, data: { effort: { level: 1, label: 'impegnato' } } }, pc: { at: 1, data: { pc: 'dorme' } } }).machines).toEqual([]);
    expect(liveBellHub({ pc: { at: 1, data: { pc: 'sconosciuto' } } }).machines).toEqual([{ machine: 'pc', state: 'unknown', why: null, tone: 'bad' }]);
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
    expect(bellTotal(groups)).toBe(1);
    // The hub down: every topic in error, nothing of the hub's left.
    const down = liveBellHub({ attesa: { at: 2, error: 'hub not reachable' }, services: { at: 2, error: 'x' } });
    expect(bellTotal(bellGroups({ waiting: [], finished: [] }, { ...NO_HUB, ...down }))).toBe(0);
  });

  test('ONE LEDGER: the button, the «Ora» tab and the Dock all say how many rows «Ora» lists', () => {
    // 22/11: the Dock said 153 (the lit subjects), the button 104 («Decidi tu»), the tab 224 (every row).
    const hub: BellHub = { ...NO_HUB, ...liveBellHub(LIVE) };
    const model = { waiting: [topicsItem('topic:q', NOW)], finished: [topicsItem('topic:a', NOW, 'done'), topicsItem('topic:b', NOW, 'done')] };
    const groups = bellGroups(model, hub);
    const rows = groups.flatMap((g) => g.entries.map((e) => e.key));
    expect(bellTotal(groups)).toBe(rows.length);
    // 1 Topics wait + 1 hub wait + 2 finished + the hub's warnings: never one group alone.
    expect(bellTotal(groups)).toBeGreaterThan(groups.find((g) => g.key === 'decide')!.entries.length + 2);
    expect(bellTone(groups)).toBe('needs-you');
  });

  test('the colour says the first group: amber for an answer, blue for the finished, grey for warnings alone', () => {
    expect(bellTone(bellGroups({ waiting: [], finished: [topicsItem('topic:a', NOW, 'done')] }, NO_HUB))).toBe('lit');
    expect(bellTone(bellGroups({ waiting: [], finished: [] }, { ...NO_HUB, ...liveBellHub(LIVE), waiting: [] }))).toBe('quiet');
    expect(bellTotal(bellGroups({ waiting: [], finished: [] }, NO_HUB))).toBe(0);
  });

  test('the automations that need you are in «Decidi tu», the same ones the Automations row counts', () => {
    const raw = { needsYou: [
      { key: 'cron:mail', provider: 'jarvis', title: 'Mail round', reason: '5 turns in a row with no work', since: NOW - 2 * HOUR },
      { key: 'wf:release', provider: 'lobster', title: 'Release', reason: 'approve the deploy', since: NOW - HOUR },
      { key: 'health:x', provider: 'health', title: 'Board push: 32% errors', reason: null },
      { provider: 'jarvis', title: 'no key' },
    ], broken: [{ key: 'cron:solid', title: 'Solid system' }] };
    const automations = automationWaitsOf(raw);
    expect(automations.map((a) => [a.key, a.gate])).toEqual([['cron:mail', false], ['wf:release', true], ['health:x', false]]);
    const groups = bellGroups({ waiting: [topicsItem('topic:q', NOW - 3 * HOUR)], finished: [] }, { ...NO_HUB, automations });
    // The oldest wait first; an automation with no date after the dated ones.
    expect(groups[0]!.entries.map((e) => e.key)).toEqual(['topic:q', 'automation:cron:mail', 'automation:wf:release', 'automation:health:x']);
  });

  test('the button counts the proxy facts that matter: a token not renewed, every account out for an hour', () => {
    const activity = { log: [
      { type: 'refresh-failed', ts: NOW - 3 * HOUR, account: 'prof-c', error: 'invalid_grant' },
      { type: 'all-exhausted', ts: NOW - 10 * 60_000 },
      { type: 'cap-exhausted', ts: NOW - 2 * HOUR, capped: ['prof-a'] },
      { type: 'rate-limited', ts: NOW - 5 * 60_000, account: 'prof-a', retryAfter: 300 },
      { type: 'auto-switch', ts: NOW - 5 * 60_000, from: 'prof-a', to: 'prof-b', reason: '429' },
    ] };
    const events = accountEvents(activity, null, NOW);
    // The token, and every account exhausted ten minutes ago; the cap of two hours ago, one account's limit and a switch are panel news.
    expect(urgentAccountEvents(events, NOW).map((e) => e.type).sort()).toEqual(['all-exhausted', 'refresh-failed']);
    // «Ora» lists those two, so the number counts two; the rest is History's.
    const groups = bellGroups({ waiting: [], finished: [] }, { ...NO_HUB, accounts: urgentAccountEvents(events, NOW) });
    expect(bellTotal(groups)).toBe(2);
    expect(bellTone(groups)).toBe('quiet');
    // An hour later only the token is left.
    expect(urgentAccountEvents(events, NOW + HOUR)).toHaveLength(1);
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

  test('account rows keep what the hub said of the latest occurrence: how and why it switched, the minutes, the names, the error', () => {
    const profiles = { profiles: [{ name: 'prof-a', label: 'work' }, { name: 'prof-b', label: 'spare' }] };
    const activity = { log: [
      { type: 'proactive-switch', ts: NOW - 50 * 60_000, from: 'prof-b', to: 'prof-a' },
      { type: 'auto-switch', ts: NOW - 10 * 60_000, from: 'prof-a', to: 'prof-b', reason: '429-error' },
      { type: 'rate-limited', ts: NOW - 20 * 60_000, account: 'prof-a', retryAfter: 290 },
      { type: 'cap-exhausted', ts: NOW - 30 * 60_000, capped: ['prof-a', 'prof-b'] },
      { type: 'all-exhausted', ts: NOW - 40 * 60_000 },
      { type: 'refresh-failed', ts: NOW - 60 * 60_000, account: 'prof-b', error: 'invalid_grant' },
    ] };
    const rows = accountEvents(activity, profiles, NOW);
    const notes = (type: string) => {
      const row = rows.find((r) => r.type === type)!;
      return accountNotes(row.latest, profiles);
    };
    expect(notes('auto-switch')).toEqual([{ key: 'proxy.note.auto' }, { key: 'proxy.event.reason', vars: { code: '429' } }]);
    expect(rows.find((r) => r.kind === 'switched')).toMatchObject({ count: 2, account: 'work', to: 'spare' });
    expect(notes('rate-limited')).toEqual([{ key: 'proxy.event.minutes', vars: { n: 5 } }]);
    expect(notes('cap-exhausted')).toEqual([{ text: 'work, spare' }]);
    expect(notes('refresh-failed')).toEqual([{ text: 'invalid_grant' }]);
    // A cap on every account and every account exhausted are two rows, not one.
    expect(rows.filter((r) => r.kind === 'limit' && r.account === null).map((r) => r.type).sort()).toEqual(['all-exhausted', 'cap-exhausted']);
  });

  test('a token event written with the account e-mail still renews the account file name', () => {
    const profiles = { profiles: [{ name: 'auto-3', label: 'user@example.com' }] };
    const failed = { log: [{ type: 'refresh-failed', ts: NOW - HOUR, account: 'user@example.com' }] };
    const [row] = accountEvents(failed, profiles, NOW);
    expect(row).toMatchObject({ kind: 'token', account: 'user@example.com', profile: 'auto-3' });
    // A later refresh written with the file name clears the failure written with the e-mail.
    const healed = { log: [...failed.log, { type: 'token-refreshed', ts: NOW - 60_000, account: 'auto-3' }] };
    expect(accountEvents(healed, profiles, NOW)).toEqual([]);
  });

  test('contradictions keep the sentence only, never the files', () => {
    const data = { contradictions: { at: 1, items: [{ a: { file: '~/AGENTS.md', text: 'x' }, b: { file: '~/CLAUDE.md', text: 'y' }, why: 'comments in two languages' }, { why: '' }] } };
    expect(contradictions(data)).toEqual([{ id: 'contradiction-0', why: 'comments in two languages' }]);
  });
});

describe('HUBBR-07: the diary in History', () => {
  test('failed runs, agents, workflows and what you said; never a routine run that went well or was skipped', () => {
    const data = { items: [
      { at: NOW - 1, kind: 'auto', who: 'Mac', title: 'Backup', outcome: 'ok', what: '', link: '#automations/launchd%3Abackup' },
      { at: NOW - 2, kind: 'auto', who: 'Jarvis', title: 'Brief', outcome: 'skipped', what: '', link: '#automations/cron%3Abrief' },
      { at: NOW - 3, kind: 'auto', who: 'Jarvis', title: 'Docs reindex', outcome: 'error', what: 'exit 1' },
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

  test('lines of other writers stay, even with outcome ok; their noise and routine runs go', () => {
    const data = { items: [
      { at: NOW - 1, kind: 'auto', who: 'Freno del Mac', title: 'Mac bloccato 10:54–11:07 da Helium', outcome: 'ok' },
      { at: NOW - 2, kind: 'auto', who: 'Abbonamenti', title: 'claude è esaurito in anticipo', outcome: null },
      { at: NOW - 3, kind: 'auto', who: 'Coda delega', title: '⏳ In attesa: 3 lavori', outcome: 'ok' },
      { at: NOW - 4, kind: 'auto', who: 'Task Topics ↔ Promemoria', title: 'Nessuna novità', outcome: 'skipped' },
      { at: NOW - 5, kind: 'auto', who: 'Mac', title: 'Backup', outcome: 'error', what: 'exit 1', link: '#automations/launchd%3Abackup' },
    ] };
    const rows = diaryForHistory(data);
    expect(rows.map((d) => d.who)).toEqual(['Freno del Mac', 'Abbonamenti', 'Mac']);
    // A failed run keeps the automation it opens.
    expect(rows[2]!.automationKey).toBe('launchd:backup');
    expect(rows[0]!.automationKey).toBeNull();
  });
});
