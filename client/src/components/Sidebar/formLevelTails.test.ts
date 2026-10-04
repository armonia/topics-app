/**
 * THE TAILS OF THE FORM ROWS SAY HOW THINGS STAND, AND NOTHING THEY DO NOT KNOW.
 *
 * Each row that opens a form where it is used (the plan under the account, the
 * providers at the foot of the model selector, the tools in the composer's «+»,
 * the calendar in its tile's menu, the machines in Dispositivi) answers the
 * common question in its tail. These are the
 * translations from the facts the menu reads to the words it shows, in both
 * languages, without a DOM.
 *
 * @covers USERMENU-10
 * @covers SETHOME-01
 */
import { describe, expect, test } from 'bun:test';
import { t, missingKeys, ensureLocaleLoaded, type Locale } from '../../lib/i18n';
import {
  calendarTail, claudePlanCompact, claudeSubscription, nodeRequestsLabel, nodesTail, planTail, providersCountTail, claudePlanWarning, runsOnClaudePlan,
  subscriptionLabel, toolsTail, usageLine, weekUsageLine,
} from './formLevelTails';
import type { ProvidersSnapshot } from '../../types';

const it = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12);

describe('planTail', () => {
  test('the free plan is «Gratuito», with nothing to warn about', () => {
    expect(planTail({ plan: 'free', seats: 1, expiresAt: null }, NOW, it)).toEqual({ text: 'Gratuito', warn: false });
  });

  test('a team plan says its seats, and a far expiry stays quiet', () => {
    expect(planTail({ plan: 'team', seats: 5, expiresAt: NOW + 200 * DAY }, NOW, it))
      .toEqual({ text: 'Team · 5 posti', warn: false });
    expect(planTail({ plan: 'team', seats: 1, expiresAt: null }, NOW, it)?.text).toBe('Team · 1 posto');
  });

  test('inside thirty days the expiry LEADS the tail, in the warning tone', () => {
    // First, not last: the tail truncates at its right end, and in a 288 px
    // menu the end was the warning (`user-menu-forms.spec.ts` measures it).
    expect(planTail({ plan: 'team', seats: 5, expiresAt: NOW + 12 * DAY + 1000 }, NOW, it))
      .toEqual({ text: 'Scade tra 12 g · Team · 5 posti', warn: true });
    expect(planTail({ plan: 'team', seats: 5, expiresAt: NOW + 3_600_000 }, NOW, it)?.text)
      .toBe('Scade oggi · Team · 5 posti');
    expect(planTail({ plan: 'team', seats: 5, expiresAt: NOW - 2 * DAY }, NOW, it))
      .toEqual({ text: 'Scaduto · Team · 5 posti', warn: true });
  });

  test('a plan not read yet says nothing', () => {
    expect(planTail(null, NOW, it)).toBeNull();
  });
});

describe('subscriptionLabel', () => {
  test('the names a person uses', () => {
    expect(subscriptionLabel({ type: 'pro', tier: null })).toBe('Pro');
    expect(subscriptionLabel({ type: 'max', tier: 'default_claude_max_20x' })).toBe('Max 20x');
    expect(subscriptionLabel({ type: 'max', tier: 'default_claude_max_5x' })).toBe('Max 5x');
    expect(subscriptionLabel({ type: 'max', tier: null })).toBe('Max');
    expect(subscriptionLabel({ type: 'team', tier: 'default_raven' })).toBe('Team');
  });

  test('what it does not know, it does not name', () => {
    expect(subscriptionLabel({ type: 'something_new', tier: 'x' })).toBeNull();
    expect(subscriptionLabel({ type: null, tier: 'default_claude_max_20x' })).toBeNull();
    expect(subscriptionLabel(undefined)).toBeNull();
  });
});

/** A snapshot whose Claude rows (`claude-code` and the `topics` runtime, both
 *  signed in with the same credentials) carry `sub`, as the server sends it. */
function snapshot(
  defaultProvider: string | null,
  sub?: { type: string | null; tier: string | null },
  claudeRows: string[] = ['claude-code', 'topics'],
): ProvidersSnapshot {
  const row = (name: string, label: string) => ({
    name, label, status: 'ready' as const, isDefault: name === defaultProvider, models: [], requirements: [],
    fetchedAt: '2026-10-02T10:00:00Z', ...(claudeRows.includes(name) && sub ? { subscription: sub } : {}),
  });
  return {
    providers: [row('topics', 'Topics'), row('claude-code', 'Claude Code'), row('codex', 'Codex')],
    defaultProvider,
    generatedAt: '2026-10-02T10:00:00Z',
  };
}

describe('claudeSubscription', () => {
  const max = { type: 'max', tier: 'default_claude_max_20x' };

  test('read from whichever Claude row has it, so a missing claude CLI does not hide it', () => {
    expect(claudeSubscription(snapshot('topics', max, ['topics']))).toEqual(max);
    expect(claudeSubscription(snapshot('codex', max, ['claude-code']))).toEqual(max);
  });

  test('no Claude row with a plan (an API key, no login) is no plan', () => {
    expect(claudeSubscription(snapshot('codex'))).toBeNull();
    expect(claudeSubscription(null)).toBeNull();
  });
});

describe('providersCountTail (model selector revision §5.3, AC-22)', () => {
  /** The same snapshot with one row's status changed. */
  const withStatus = (name: string, status: 'ready' | 'unavailable' | 'error') => {
    const base = snapshot('claude-code');
    return { ...base, providers: base.providers.map((p) => (p.name === name ? { ...p, status } : p)) };
  };

  test('the ready providers, topics included: it is a card of the providers level', () => {
    expect(providersCountTail(snapshot('claude-code'), it)).toEqual({ text: '3 pronti', warn: false });
    expect(providersCountTail(withStatus('codex', 'unavailable'), it)).toEqual({ text: '2 pronti', warn: false });
  });

  test('the errors are added, in the warning tone', () => {
    expect(providersCountTail(withStatus('codex', 'error'), it)).toEqual({ text: '2 pronti · 1 errore', warn: true });
  });

  test('nothing ready is a warning; no snapshot yet is silence', () => {
    const none = { ...snapshot('claude-code'), providers: snapshot('claude-code').providers.map((p) => ({ ...p, status: 'unavailable' as const })) };
    expect(providersCountTail(none, it)).toEqual({ text: 'Nessuno pronto', warn: true });
    expect(providersCountTail(null, it)).toBeNull();
  });

  test('in english too', async () => {
    await ensureLocaleLoaded('en');
    const en = (key: string, vars?: Record<string, string | number>) => t(key, 'en', vars);
    expect(providersCountTail(withStatus('codex', 'error'), en)?.text).toBe('2 ready · 1 error');
  });
});

describe('claudePlanWarning (model selector revision §4.5, AC-33)', () => {
  test('nothing under the threshold', () => {
    expect(claudePlanWarning({ utilization: 42 }, { utilization: 49 }, it)).toBeNull();
    expect(claudePlanWarning(null, null, it)).toBeNull();
  });
  test('the higher window at or over the threshold, in one short reading', () => {
    expect(claudePlanWarning({ utilization: 42 }, { utilization: 67 }, it)).toBe('sett. 67%');
    expect(claudePlanWarning({ utilization: 88 }, { utilization: 67 }, it)).toBe('5 h 88%');
  });
});

describe('claudePlanCompact', () => {
  const max = { type: 'max', tier: 'default_claude_max_20x' };

  test('the plan and the five-hour window in one line', () => {
    expect(claudePlanCompact(max, { utilization: 41.6 }, it)).toEqual({ text: 'Max 20x · 5 h al 42%', warn: false });
  });

  test('past the warning threshold the line asks for attention', () => {
    expect(claudePlanCompact(max, { utilization: 80 }, it)).toEqual({ text: 'Max 20x · 5 h al 80%', warn: true });
  });

  test('either half alone, and nothing with neither', () => {
    expect(claudePlanCompact(max, null, it)).toEqual({ text: 'Max 20x', warn: false });
    expect(claudePlanCompact(null, { utilization: 10 }, it)).toEqual({ text: '5 h al 10%', warn: false });
    expect(claudePlanCompact({ type: 'mystery', tier: null }, null, it)).toBeNull();
    expect(claudePlanCompact(null, null, it)).toBeNull();
  });

  test('only the Claude runtimes run on the plan', () => {
    expect(runsOnClaudePlan('claude-code')).toBe(true);
    expect(runsOnClaudePlan('topics')).toBe(true);
    expect(runsOnClaudePlan('codex')).toBe(false);
    expect(runsOnClaudePlan(null)).toBe(false);
  });
});

describe('toolsTail, calendarTail, nodesTail', () => {
  const server = (state: 'ready' | 'failed' | 'excluded' | 'needs-auth') => ({ name: state, transport: null, state, tools: [], skills: [] });

  test('tools count the servers that answered', () => {
    expect(toolsTail({ enabled: true, servers: [server('ready'), server('ready'), server('failed')] }, it)).toBe('2 attivi');
    expect(toolsTail({ enabled: true, servers: [server('ready')] }, it)).toBe('1 attivo');
    expect(toolsTail({ enabled: true, servers: [server('excluded')] }, it)).toBe('Nessuno');
    expect(toolsTail({ enabled: false, servers: [] }, it)).toBe('Spenti');
    // Not mounted yet, or mounting: an empty list is not «none».
    expect(toolsTail({ enabled: true, servers: [], mounted: false, mounting: false }, it)).toBeNull();
    expect(toolsTail({ enabled: true, servers: [], mounted: false, mounting: true }, it)).toBeNull();
    expect(toolsTail({ enabled: true, servers: [], mounted: true, mounting: false }, it)).toBe('Nessuno');
    expect(toolsTail(null, it)).toBeNull();
  });

  test('the calendar in the three states its level knows', () => {
    expect(calendarTail({ calendarFeedUrl: 'set', calendarEnabled: true }, it)).toBe('Collegato');
    expect(calendarTail({ calendarFeedUrl: 'set', calendarEnabled: false }, it)).toBe('In pausa');
    expect(calendarTail({ calendarFeedUrl: null, calendarEnabled: true }, it)).toBe('Non collegato');
    expect(calendarTail(null, it)).toBeNull();
  });

  test('nodes', () => {
    expect(nodesTail(0, it)).toBe('Nessuno');
    expect(nodesTail(1, it)).toBe('1 nodo');
    expect(nodesTail(3, it)).toBe('3 nodi');
    expect(nodesTail(null, it)).toBeNull();
  });
});

describe('usageLine', () => {
  test('the five-hour window with its reset, or without', () => {
    expect(usageLine({ utilization: 41.6, resetsAtMs: 1 }, () => '20:49', it)).toBe('Finestra di 5 ore al 42% · riparte alle 20:49');
    expect(usageLine({ utilization: 7, resetsAtMs: null }, () => 'x', it)).toBe('Finestra di 5 ore al 7%');
    expect(usageLine(null, () => 'x', it)).toBeNull();
  });
});

describe('every word of the tails exists in both languages', () => {
  const KEYS = [
    'userMenu.none', 'userMenu.plan.free', 'userMenu.plan.team', 'userMenu.plan.teamOne', 'userMenu.plan.expiresIn',
    'userMenu.plan.expiresToday', 'userMenu.plan.expired', 'userMenu.tools.off', 'userMenu.tools.one', 'userMenu.tools.many',
    'userMenu.calendar.on', 'userMenu.calendar.paused', 'userMenu.calendar.none', 'userMenu.nodes.one', 'userMenu.nodes.many',
    'userMenu.nodes.requests', 'userMenu.subscription', 'userMenu.usage.fiveHours', 'userMenu.usage.fiveHoursReset',
    'userMenu.level.close', 'userMenu.subscriptionUnknown', 'userMenu.usage.none',
    'home.providers.ready', 'home.providers.readyOne', 'home.providers.noneReady',
    'ai.selector.providers.errors', 'ai.selector.providers.errorOne', 'ai.selector.plan.fiveHour',
    'home.claudeUsage', 'home.providers', 'home.tools', 'home.calendar', 'home.machines',
  ];

  test('italian: no bare key', () => {
    for (const key of KEYS) expect(t(key, 'it' as Locale)).not.toBe(key);
  });

  test('english: really translated', async () => {
    const missing = new Set(await missingKeys('en'));
    for (const key of KEYS) expect(missing.has(key)).toBe(false);
  });
});

describe('nodeRequestsLabel', () => {
  test('one request is singular, in both languages', () => {
    expect(nodeRequestsLabel(1, it)).toBe('1 richiesta da un altro computer aspetta una risposta');
    expect(nodeRequestsLabel(1, (key, vars) => t(key, 'en', vars))).toBe('1 request from another computer is waiting for an answer');
    expect(nodeRequestsLabel(3, it)).toBe('3 richieste da altri computer aspettano una risposta');
  });
});

/** @covers CMDUI-05 */
describe('the week after the five hours', () => {
  const max = { type: 'max', tier: 'default_claude_max_20x' };

  test('the compact line adds the week after the five hours', () => {
    expect(claudePlanCompact(max, { utilization: 38 }, it, { utilization: 78 })).toEqual({ text: 'Max 20x · 5 h al 38% · sett. 78%', warn: true });
    expect(claudePlanCompact(max, { utilization: 10 }, it, { utilization: 20 })).toEqual({ text: 'Max 20x · 5 h al 10% · sett. 20%', warn: false });
  });

  test('the week alone warns too: its block stops work for days', () => {
    expect(claudePlanCompact(null, null, it, { utilization: 90 })).toEqual({ text: 'sett. 90%', warn: true });
  });

  test('the panel line names the day and the hour of the reset', () => {
    expect(weekUsageLine({ utilization: 77.6, resetsAtMs: 1 }, () => 'sab 13:00', it)).toBe('Settimana al 78% · riparte sab 13:00');
    expect(weekUsageLine({ utilization: 12, resetsAtMs: null }, () => 'x', it)).toBe('Settimana al 12%');
    expect(weekUsageLine(null, () => 'x', it)).toBeNull();
  });
});
