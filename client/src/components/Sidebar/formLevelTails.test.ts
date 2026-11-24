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
  calendarTail, claudeSubscription, nodeRequestsLabel, nodesTail, planRowLabel, planRowTail, providersCountTail, claudePlanWarning, subscriptionLabel, toolsTail, usageLine,
} from './formLevelTails';
import type { ProvidersSnapshot } from '../../types';

const it = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12);

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

describe('plan row', () => {
  test('the label names the plan and the tail keeps the seats', () => {
    const team = { plan: 'team', seats: 5, expiresAt: null } as const;
    expect(planRowLabel(team, it)).toBe('Piano Team');
    expect(planRowTail(team, NOW, it)).toEqual({ text: '5 posti', warn: false });
  });

  test('the free plan has a label and no tail; a near expiry warns alone', () => {
    const free = { plan: 'free', seats: 1, expiresAt: null } as const;
    expect(planRowLabel(free, it)).toBe('Piano Gratuito');
    expect(planRowTail(free, NOW, it)).toBeNull();
    expect(planRowTail({ plan: 'team', seats: 5, expiresAt: NOW + 3 * DAY }, NOW, it)?.warn).toBe(true);
  });
});
