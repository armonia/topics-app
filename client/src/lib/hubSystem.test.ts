/**
 * What the client reads out of the hub's live topics. The inputs are the
 * hub's own shapes (usage-hub src/server.mjs), trimmed.
 * @covers HUBBR-03
 */
import { describe, expect, test } from 'bun:test';
import {
  automationSummary, closeWaitingBody, failedJobs, firingAlerts, quotaLines, redGates, servicesDown, waitingItems,
} from './hubSystem';

const SERVICES = { at: 1, services: [
  { id: 'usage-hub', name: 'Hub dei consumi', state: 'vivo', problem: null },
  { id: 'openclaw', name: 'OpenClaw', state: 'spento', problem: null },
  { id: 'free-router', name: 'Free router', state: 'in attesa', problem: null },
  { id: 'docs', name: 'Docs index', state: 'vivo', problem: 'non ascolta su :3342' },
] };
const PACE = [
  { provider: 'claude', account: 'a@x', active: true, used: 62, fiveHour: null },
  { provider: 'claude', account: 'b@x', active: false, used: 100, fiveHour: null },
  { provider: 'codex', account: 'c@x', active: true, used: 12, fiveHour: { used: 85, resetsAt: 1 } },
];

describe('HUBBR-03: the hub readers', () => {
  test('quotas: the active accounts only, warm at 80% of either window', () => {
    expect(quotaLines(PACE)).toEqual([
      { key: 'claude:a@x', provider: 'claude', used: 62, fiveHour: null, hot: false },
      { key: 'codex:c@x', provider: 'codex', used: 12, fiveHour: 85, hot: true },
    ]);
    expect(quotaLines({ not: 'a list' })).toEqual([]);
  });

  test('services down: a problem or stopped; switched off on purpose and on demand are not down', () => {
    const withStopped = { services: [...SERVICES.services, { id: 'gw', name: 'Gateway', state: 'fermo', problem: null }] };
    expect(servicesDown(withStopped)).toEqual([
      { id: 'docs', name: 'Docs index', problem: 'non ascolta su :3342' },
      { id: 'gw', name: 'Gateway', problem: null },
    ]);
  });

  test('waiting items keep the hub order, drop the malformed, accept only the three link forms of the hub', () => {
    const items = waitingItems({ at: 1, items: [
      { id: 'a', tipo: 'decisione', title: 'Ship it?', why: 'because', link: 'https://example.com/x', from: 'guardiano', due: 10 },
      { id: 'b', tipo: 'vista', title: 'Look', link: 'javascript:alert(1)' },
      { id: 'c', title: '' },
      { tipo: 'spesa', title: 'no id' },
      { id: 'd', tipo: 'boh', title: 'Unknown kind' },
    ] });
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'd']);
    expect(items[0]).toEqual({ id: 'a', kind: 'decisione', title: 'Ship it?', why: 'because', link: 'https://example.com/x', from: 'guardiano', due: 10, since: null });
    expect(items[1]!.link).toBeNull();
    expect(items[2]!.kind).toBe('decisione');
    expect(waitingItems(null)).toEqual([]);
    const links = waitingItems({ items: [
      { id: 'p', title: 'Page', link: '#automations/x' },
      { id: 'c', title: 'Claude', link: 'claude://resume/abc' },
      { id: 'f', title: 'File', link: 'file:///etc/passwd' },
    ] }, '127.0.0.1').map((i) => i.link);
    expect(links).toEqual(['http://127.0.0.1:3360/#automations/x', 'claude://resume/abc', null]);
  });

  test('a hub page link opens only on the machine of the hub, never as the phone own localhost', () => {
    const page = { items: [{ id: 'p', title: 'Page', link: '#automations/k' }] };
    const linkOn = (host: string) => waitingItems(page, host)[0]!.link;
    expect(linkOn('127.0.0.1')).toBe('http://127.0.0.1:3360/#automations/k');
    expect(linkOn('localhost')).toBe('http://127.0.0.1:3360/#automations/k');
    expect(linkOn('mac.tail1234.ts.net')).toBeNull();
    expect(linkOn('192.168.1.20')).toBeNull();
  });

  test('the close body is the one the hub expects', () => {
    expect(closeWaitingBody('4887578f')).toEqual({ kind: 'chiudi', ref: '4887578f' });
  });

  test('alerts are the firing ones, not the rules', () => {
    const data = { rules: [{ message: 'rule' }], firing: [{ id: 'muse:pace', subject: 'Muse pace', source: 'ritmo-muse', message: 'Ritmo Muse: 71%' }, { id: 'x' }] };
    expect(firingAlerts(data)).toEqual([{ id: 'muse:pace', subject: 'Muse pace', message: 'Ritmo Muse: 71%', source: 'ritmo-muse' }]);
  });

  test('red gates: classes and brakes that say go false', () => {
    const data = {
      classes: { interattivo: { go: true, reason: 'ok' }, batch: { go: false, reason: 'quota finita' } },
      brakes: { muse: { go: false, reason: 'sopra ritmo' }, codex: { go: true } },
      providers: { claude: { state: 'libero' } },
    };
    expect(redGates(data)).toEqual([
      { id: 'class:batch', name: 'batch', kind: 'class', reason: 'quota finita' },
      { id: 'brake:muse', name: 'muse', kind: 'brake', reason: 'sopra ritmo' },
    ]);
    expect(redGates('nope')).toEqual([]);
  });

  test('automations: counters and the next run from the summary, failed jobs from the full list', () => {
    expect(automationSummary({ needsYou: 1, broken: 4, ok: 81, runsToday: 9209, calendar: { count: 3, next: { title: 'Backup', at: 50 } } }))
      .toEqual({ needsYou: 1, broken: 4, ok: 81, runsToday: 9209, next: { title: 'Backup', at: 50 } });
    expect(automationSummary({})).toEqual({ needsYou: 0, broken: 0, ok: 0, runsToday: 0, next: null });
    expect(automationSummary(null)).toBeNull();
    expect(failedJobs({ broken: [{ key: 'gh:x', title: 'Parametri paghe', reason: 'ha fallito domenica', last: { at: 9, outcome: 'error' } }, { key: 'k' }] }))
      .toEqual([{ key: 'gh:x', title: 'Parametri paghe', at: 9, reason: 'ha fallito domenica' }]);
  });
});
