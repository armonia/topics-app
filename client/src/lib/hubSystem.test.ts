/**
 * What the status strip and the System pane read out of the hub's live topics.
 * The inputs are the hub's own shapes (usage-hub src/server.mjs), trimmed.
 * @covers HUBBR-04, HUBBR-05
 */
import { describe, expect, test } from 'bun:test';
import {
  HUB_PAGES_BASE, automationSummary, closeWaitingBody, failedJobs, firingAlerts, macGlance, quotaLines, redGates, servicesDown, stripModel, waitingItems,
} from './hubSystem';

const SERVICES = { at: 1, services: [
  { id: 'usage-hub', name: 'Hub dei consumi', state: 'vivo', problem: null },
  { id: 'openclaw', name: 'OpenClaw', state: 'spento', problem: null },
  { id: 'free-router', name: 'Free router', state: 'in attesa', problem: null },
  { id: 'docs', name: 'Docs index', state: 'vivo', problem: 'non ascolta su :3342' },
] };
const MAC = { strained: false, swapUsedGB: 1.26, swapSustained: false, effort: { parts: [{ key: 'cpu', pct: 34.4 }, { key: 'mem', pct: 77 }] } };
const PACE = [
  { provider: 'claude', account: 'a@x', active: true, used: 62, fiveHour: null },
  { provider: 'claude', account: 'b@x', active: false, used: 100, fiveHour: null },
  { provider: 'codex', account: 'c@x', active: true, used: 12, fiveHour: { used: 85, resetsAt: 1 } },
];

describe('HUBBR-04: the strip', () => {
  test('hidden while the hub was never read', () => {
    expect(stripModel({}, false).state).toBe('hidden');
    expect(stripModel({ mac: { error: 'down', at: 1 } }, false).state).toBe('hidden');
  });

  test('down once read and no topic answers: no numbers', () => {
    const m = stripModel({ mac: { error: 'down', at: 2 }, pace: { error: 'down', at: 2 } }, true);
    expect(m).toEqual({ state: 'down', servicesDown: 0, mac: null, quotas: [] });
  });

  test('calm with everything fine, attention with a service down, an alert, a red gate or a strained Mac', () => {
    const fine = { mac: { data: MAC, at: 1 }, services: { data: { services: [SERVICES.services[0]] }, at: 1 } };
    expect(stripModel(fine, true).state).toBe('calm');
    const m = stripModel({ ...fine, services: { data: SERVICES, at: 1 } }, true);
    expect(m.state).toBe('attention');
    expect(m.servicesDown).toBe(2);
    expect(stripModel({ ...fine, alerts: { data: { firing: [{ id: 'x', message: 'm' }] }, at: 1 } }, true).state).toBe('attention');
    expect(stripModel({ ...fine, gates: { data: { classes: { batch: { go: false } } }, at: 1 } }, true).state).toBe('attention');
    expect(stripModel({ ...fine, mac: { data: { ...MAC, strained: true }, at: 1 } }, true).state).toBe('attention');
  });

  test('a topic in error adds nothing, the others still show', () => {
    const m = stripModel({ mac: { data: MAC, at: 1 }, pace: { error: 'down', at: 1 } }, true);
    expect(m.state).toBe('calm');
    expect(m.quotas).toEqual([]);
    expect(m.mac?.cpu).toBe(34);
  });

  test('numbers: cpu from the effort parts, swap in GB, the active accounts only', () => {
    expect(macGlance(MAC)).toEqual({ cpu: 34, swapGB: 1.26, strained: false, swapHot: false });
    expect(macGlance(null)).toBeNull();
    expect(quotaLines(PACE)).toEqual([
      { key: 'claude:a@x', provider: 'claude', used: 62, fiveHour: null, hot: false },
      { key: 'codex:c@x', provider: 'codex', used: 12, fiveHour: 85, hot: true },
    ]);
    expect(quotaLines({ not: 'a list' })).toEqual([]);
  });

  test('services down follow the hub rule: a problem, stopped or not loaded; on demand is not down', () => {
    expect(servicesDown(SERVICES).map((s) => s.id)).toEqual(['openclaw', 'docs']);
  });
});

describe('HUBBR-05: the System pane sections', () => {
  test('waiting items keep the hub order, drop the malformed, accept only the three link forms of the hub', () => {
    const items = waitingItems({ at: 1, items: [
      { id: 'a', tipo: 'decisione', title: 'Ship it?', why: 'because', link: 'https://example.com/x', from: 'guardiano', due: 10 },
      { id: 'b', tipo: 'vista', title: 'Look', link: 'javascript:alert(1)' },
      { id: 'c', title: '' },
      { tipo: 'spesa', title: 'no id' },
      { id: 'd', tipo: 'boh', title: 'Unknown kind' },
    ] });
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'd']);
    expect(items[0]).toEqual({ id: 'a', kind: 'decisione', title: 'Ship it?', why: 'because', link: 'https://example.com/x', from: 'guardiano', due: 10 });
    expect(items[1]!.link).toBeNull();
    expect(items[2]!.kind).toBe('decisione');
    expect(waitingItems(null)).toEqual([]);
    const links = waitingItems({ items: [
      { id: 'p', title: 'Page', link: '#automations/x' },
      { id: 'c', title: 'Claude', link: 'claude://resume/abc' },
      { id: 'f', title: 'File', link: 'file:///etc/passwd' },
    ] }).map((i) => i.link);
    expect(links).toEqual([`${HUB_PAGES_BASE}#automations/x`, 'claude://resume/abc', null]);
  });

  test('the close body is the one the hub expects', () => {
    expect(closeWaitingBody('4887578f')).toEqual({ kind: 'chiudi', ref: '4887578f' });
  });

  test('alerts are the firing ones, not the rules', () => {
    const data = { rules: [{ message: 'rule' }], firing: [{ id: 'muse:pace', subject: 'Muse pace', message: 'Ritmo Muse: 71%' }, { id: 'x' }] };
    expect(firingAlerts(data)).toEqual([{ id: 'muse:pace', subject: 'Muse pace', message: 'Ritmo Muse: 71%' }]);
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
    expect(failedJobs({ broken: [{ key: 'gh:x', title: 'Parametri paghe', last: { at: 9, outcome: 'error' } }, { key: 'k' }] }))
      .toEqual([{ key: 'gh:x', title: 'Parametri paghe', at: 9 }]);
  });
});
