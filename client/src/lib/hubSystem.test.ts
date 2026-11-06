/**
 * What the client reads out of the hub's live topics. The inputs are the
 * hub's own shapes (usage-hub src/server.mjs), trimmed.
 * @covers HUBBR-03
 */
import { describe, expect, test } from 'bun:test';
import {
  automationJarvisText, automationKeyOfLink, automationSummary, hubPlaceOfLink, jarvisHref, jarvisLinks, macStrain, closeWaitingBody, failedJobs, firingAlerts, quotaLines, redGates, servicesDown, waitingItems,
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
    expect(items[0]).toEqual({ id: 'a', kind: 'decisione', title: 'Ship it?', why: 'because', link: 'https://example.com/x', automationKey: null, place: null, from: 'guardiano', due: 10, since: null });
    expect(items[1]!.link).toBeNull();
    expect(items[2]!.kind).toBe('decisione');
    expect(waitingItems(null)).toEqual([]);
    const links = waitingItems({ items: [
      { id: 'p', title: 'Page', link: '#journal' },
      { id: 'c', title: 'Claude', link: 'claude://resume/abc' },
      { id: 'f', title: 'File', link: 'file:///etc/passwd' },
    ] }, '127.0.0.1').map((i) => i.link);
    expect(links).toEqual(['http://127.0.0.1:3360/#journal', 'claude://resume/abc', null]);
  });

  test('a hub page link opens only on the machine of the hub, never as the phone own localhost', () => {
    const page = { items: [{ id: 'p', title: 'Page', link: '#journal' }] };
    const linkOn = (host: string) => waitingItems(page, host)[0]!.link;
    expect(linkOn('127.0.0.1')).toBe('http://127.0.0.1:3360/#journal');
    expect(linkOn('localhost')).toBe('http://127.0.0.1:3360/#journal');
    expect(linkOn('mac.tail1234.ts.net')).toBeNull();
    expect(linkOn('192.168.1.20')).toBeNull();
  });

  test('a link to one automation opens Topics own view on every device, not the hub page', () => {
    const page = { items: [{ id: 'p', title: 'Page', link: '#automations/cron%3Abackup', from: 'guardiano' }] };
    for (const host of ['127.0.0.1', 'mac.tail1234.ts.net']) {
      const [item] = waitingItems(page, host);
      expect(item!.automationKey).toBe('cron:backup');
      expect(item!.link).toBeNull();
      expect(item!.from).toBe('guardiano');
    }
    expect(automationKeyOfLink('#automations/')).toBeNull();
    expect(automationKeyOfLink('#automations/%E0%A4%A')).toBeNull();
    expect(automationKeyOfLink('https://x/#automations/k')).toBeNull();
  });

  test('a link to a hub page that moved into Topics opens Topics, on every device; the overview stays a hub link', () => {
    const items = waitingItems({ items: [
      { id: 'w', title: 'Work', link: '#work/in-corso' },
      { id: 's', title: 'Sessions', link: '#sessions' },
      { id: 'v', title: 'Services', link: '#services' },
      { id: 'l', title: 'Log', link: '#logs' },
      { id: 'a', title: 'Accounts', link: '#accounts' },
      { id: 'u', title: 'Usage', link: '#usage' },
      { id: 'c', title: 'Context', link: '#context' },
      { id: 'o', title: 'Overview', link: '#overview' },
    ] }, 'mac.tail1234.ts.net');
    expect(items.map((i) => i.place)).toEqual([
      { kind: 'menu', level: 'agents' }, { kind: 'menu', level: 'agents' }, { kind: 'utility', type: 'processes' }, { kind: 'log' },
      { kind: 'utility', type: 'accounts' }, { kind: 'utility', type: 'dashboard' }, { kind: 'menu', level: 'context' }, null,
    ]);
    // Moved into Topics: no hub link left, so nothing depends on the hub page.
    expect(items.slice(0, 7).every((i) => i.link === null)).toBe(true);
    expect(hubPlaceOfLink('https://x/#work')).toBeNull();
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

  test('the Mac under strain: the red level or a full sustained swap, never a busy Mac', () => {
    expect(macStrain({ effort: { level: 2, label: 'sotto sforzo' } })).toBe('sotto sforzo');
    expect(macStrain({ effort: { level: 1, label: 'impegnato' } })).toBeNull();
    expect(macStrain({ effort: { level: 0 }, swapSustained: true, swapUsedGB: 15, swapTotalGB: 16 })).toBe('memoria sotto pressione');
    expect(macStrain({ effort: { level: 0 }, swapSustained: false, swapUsedGB: 15, swapTotalGB: 16 })).toBeNull();
    expect(macStrain(null)).toBeNull();
  });
});

describe('writing to Jarvis', () => {
  test('only http links of the hub config count, and WhatsApp carries the message', () => {
    expect(jarvisLinks({ jarvis: { whatsapp: 'javascript:alert(1)' } })).toBeNull();
    expect(jarvisLinks(null)).toBeNull();
    const links = jarvisLinks({ jarvis: { whatsapp: 'https://wa.me/1', discord: 'https://discord.com/x' } });
    const text = automationJarvisText('Reindex docs', 'gh:docs', 'fallita 3 volte');
    expect(text).toBe('Automazione «Reindex docs» (gh:docs): fallita 3 volte');
    expect(jarvisHref(links, text)).toBe(`https://wa.me/1?text=${encodeURIComponent(text)}`);
    expect(jarvisHref({ whatsapp: null, discord: 'https://discord.com/x' }, text)).toBe('https://discord.com/x');
    expect(jarvisHref(null, text)).toBeNull();
  });
});
