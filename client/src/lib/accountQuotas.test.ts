/**
 * Accounts and quotas as pure reads of the Claude proxy and the hub: the
 * accounts in the order they are used, their state, the reserve keys, Codex
 * and Muse read-only with the brake, the proxy's rules, and the request behind
 * every command. Inputs are the services' own shapes, trimmed, with
 * placeholder names.
 * @covers HUBBR-10
 * @covers HUBBR-11
 */
import { describe, expect, test } from 'bun:test';
import {
  accountCount, backgroundHold, brakeClasses, capInput, commandRequest, elidesArticle, hotDecision, hubProse, keyMove, meteredProviders, oneDecimal,
  paceLines, planName, readProxyAccounts, readProxySettings,
} from './accountQuotas';
import { highestQuota, profileDoor } from '../components/Sidebar/hotQuota';
import { t } from './i18n';
import ACCOUNTS_IT from './i18n-accounts-it';
import ACCOUNTS_EN from './i18n-accounts-en';

const it = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);

const NOW = 1_800_000_000_000;
const S = (ms: number) => Math.floor(ms / 1000);

const profiles = {
  profiles: [
    { name: 'auto-3', label: 'terzo@example.com', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', isActive: false, priority: 2, disabled: true, limited: true, refreshFailed: { error: 'Refresh token expired' }, rateLimits: { sevenD: { utilization: 1, reset: S(NOW - 4 * 86_400_000) } }, cap: { override: {}, effective: {}, over: false } },
    { name: 'auto-1', label: 'lavoro@example.com', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', isActive: true, priority: 0, rateLimits: { fiveH: { utilization: 0.42, reset: S(NOW + 3_600_000) }, sevenD: { utilization: 0.86, reset: S(NOW + 86_400_000) } }, cap: { override: { fiveH: null, sevenD: null }, effective: { fiveH: null, sevenD: 90 }, over: false } },
    { name: 'auto-2', label: 'riserva@example.com', subscriptionType: 'pro', isActive: false, priority: 5, expiresAt: NOW + 86_400_000, rateLimits: { sevenD: { utilization: 0.31, reset: S(NOW + 2 * 86_400_000) } }, cap: { override: { fiveH: 80, sevenD: 60 }, effective: { fiveH: 80, sevenD: 60 }, over: true } },
    { name: 'auto-4', label: 'scaduto@example.com', subscriptionType: 'max', isActive: false, priority: 1, expiresAt: NOW - 1, rateLimits: null },
    { label: 'senza nome' },
  ],
  apiProfiles: [
    { type: 'api', name: 'k-low', label: 'Chiave di prova', priority: 10, disabled: false },
    { type: 'api', name: 'k-high', label: 'Chiave acme-web', priority: 20, disabled: true },
  ],
  allExhausted: false,
};

describe('readProxyAccounts', () => {
  const read = readProxyAccounts(profiles, NOW)!;

  test('the one in use first, then by priority, the switched-off ones last', () => {
    expect(read.accounts.map((a) => a.name)).toEqual(['auto-1', 'auto-2', 'auto-4', 'auto-3']);
  });

  test('each state from the proxy\'s own facts', () => {
    expect(read.accounts.map((a) => a.state)).toEqual(['in-use', 'capped', 'expired', 'off']);
  });

  test('windows in %, resets in ms; a missing window is null, not 0', () => {
    const [work, , expired] = read.accounts;
    expect(work.fiveH).toEqual({ pct: 42, resetsAtMs: S(NOW + 3_600_000) * 1000 });
    expect(work.week?.pct).toBe(86);
    expect(expired.fiveH).toBeNull();
    expect(expired.week).toBeNull();
  });

  test('a window whose reset is past is over: no bar, not an old 100%', () => {
    // The real proxy keeps the last reading of an account it stopped using:
    // a week at 100% that reset four days ago.
    const old = read.accounts.find((a) => a.name === 'auto-3')!;
    expect(old.week).toBeNull();
    expect(read.accounts.find((a) => a.name === 'auto-2')!.week?.pct).toBe(31);
  });

  test('the plan as a person names it', () => {
    expect(read.accounts.map((a) => a.plan)).toEqual(['Max 20x', 'Pro', 'Max', 'Max 5x']);
    expect(planName('enterprise_v2', '')).toBeNull();
  });

  test('own caps apart from the caps in force', () => {
    expect(read.accounts[0].cap).toEqual({ ownFiveH: null, ownWeek: null, fiveH: null, week: 90, over: false });
    expect(read.accounts[1].cap).toEqual({ ownFiveH: 80, ownWeek: 60, fiveH: 80, week: 60, over: true });
  });

  test('the reserve keys in the order they are used, higher priority first', () => {
    expect(read.keys.map((k) => [k.name, k.disabled])).toEqual([['k-high', true], ['k-low', false]]);
  });

  test('an error answer is not an empty list', () => {
    expect(readProxyAccounts({ error: 'switchboard not reachable' }, NOW)).toBeNull();
    expect(readProxyAccounts(null, NOW)).toBeNull();
  });
});

describe('keyMove', () => {
  const keys = readProxyAccounts(profiles, NOW)!.keys;
  test('up goes one above the key over it, down one under the key below', () => {
    expect(keyMove(keys, 1, -1)).toEqual({ name: 'k-low', priority: 21 });
    expect(keyMove(keys, 0, 1)).toEqual({ name: 'k-high', priority: 9 });
  });
  test('nothing past the edges', () => {
    expect(keyMove(keys, 0, -1)).toBeNull();
    expect(keyMove(keys, 1, 1)).toBeNull();
  });
});

describe('capInput', () => {
  test('empty is no cap, 1..99 a cap, the rest refused', () => {
    expect(capInput('')).toBeNull();
    expect(capInput(' 75 ')).toBe(75);
    expect(capInput('0')).toBe('invalid');
    expect(capInput('100')).toBe('invalid');
    expect(capInput('7,5')).toBe('invalid');
  });
});

describe('readProxySettings', () => {
  test('the proxy\'s rules, with its defaults where a field is missing', () => {
    expect(readProxySettings({ proxyEnabled: true, autoSwitch: true, rotationStrategy: 'margin', usageCap5h: null, usageCap7d: 90, usdEur: 0.9 })).toEqual({
      proxyEnabled: true, autoSwitch: true, notifications: true, rotationStrategy: 'margin', rotationIntervalMin: 60, maxConcurrentPerAccount: 8,
      serializeRequests: false, usageCap5h: null, usageCap7d: 90, usageCapHoldMin: 10, usdEur: 0.9,
    });
  });
  test('an error answer is not a set of rules', () => {
    expect(readProxySettings({ error: 'down' })).toBeNull();
  });
});

const pace = [
  { provider: 'claude', account: 'lavoro@example.com', active: true, used: 86, elapsedPct: 55, pace: 1.6, fiveHour: { used: 42 } },
  { provider: 'codex', account: 'riserva@example.com', active: false, used: 2 },
  { provider: 'codex', account: 'codex@example.com', active: true, used: 28, elapsedPct: 40, pace: 0.7, resetsAt: NOW + 86_400_000, fiveHour: { used: 8 } },
  { provider: 'muse', account: 'muse@example.com', active: true, used: 40, pace: 1, quotaStale: true },
];
const gates = {
  classes: {
    batch: { order: ['free', 'muse', 'codex', 'claude'], go: false, provider: null, reason: 'quota finita fino a lunedì' },
    interattivo: { order: ['claude', 'codex'], go: true, provider: 'claude', account: 'lavoro@example.com', reason: '86% usato' },
    sconosciuta: { order: ['x'], go: true },
  },
  providers: { codex: { state: 'libero', reason: 'ok' }, muse: { state: 'frenato', reason: 'sopra ritmo', waitUntil: NOW + 21_600_000 } },
  overrides: [
    { provider: 'codex', until: NOW + 7_200_000, by: 'topics' },
    { provider: 'codex', until: NOW - 1 },
    { provider: '*', hold: true, until: NOW + 3_600_000 },
    { provider: 'muse', exhausted: true, until: NOW + 3_600_000 },
  ],
};

describe('meteredProviders', () => {
  const read = meteredProviders(pace, gates, NOW);

  test('Codex and Muse only, the account in use of each', () => {
    expect(read.map((p) => [p.provider, p.account])).toEqual([['codex', 'codex@example.com'], ['muse', 'muse@example.com']]);
  });

  test('windows, pace and an old reading as the hub gives them', () => {
    expect(read[0]).toMatchObject({ fiveH: 8, week: 28, pace: 0.7, stale: false, weekResetsAtMs: NOW + 86_400_000 });
    expect(read[1]).toMatchObject({ fiveH: null, week: 40, stale: true });
  });

  test('the brake and the unlock in force; an expired or exhausted entry is not an unlock', () => {
    expect(read[0]).toMatchObject({ braked: false, unlockedUntil: NOW + 7_200_000 });
    expect(read[1]).toMatchObject({ braked: true, brakeReason: 'sopra ritmo', brakedUntil: NOW + 21_600_000, unlockedUntil: null });
  });

  test('no hub, no provider', () => {
    expect(meteredProviders(null, null, NOW)).toEqual([]);
  });
});

describe('the brake', () => {
  test('the known classes in reading order, an unknown one left out', () => {
    expect(brakeClasses(gates).map((c) => [c.id, c.order.join('>'), c.go])).toEqual([
      ['interattivo', 'claude>codex', true],
      ['batch', 'free>muse>codex>claude', false],
    ]);
  });

  test('the background stop until its end, none when expired', () => {
    expect(backgroundHold(gates, NOW)).toBe(NOW + 3_600_000);
    expect(backgroundHold(gates, NOW + 4_000_000)).toBeNull();
  });

  test('one pace line per provider, the account in use', () => {
    expect(paceLines(pace).map((l) => [l.provider, l.account, l.used])).toEqual([
      ['claude', 'lavoro@example.com', 86], ['codex', 'codex@example.com', 28], ['muse', 'muse@example.com', 40],
    ]);
  });
});

describe('accountCount', () => {
  test('the proxy\'s named accounts, off and expired included, plus Codex and Muse: what the view lists', () => {
    // 4 named profiles (one off, one expired) + Codex + Muse, though the hub has 4 pace rows.
    expect(accountCount(profiles, pace)).toBe(6);
    expect(accountCount(profiles, pace)).toBe(readProxyAccounts(profiles, NOW)!.accounts.length + meteredProviders(pace, gates, NOW).length);
  });
  test('proxy silent: only what the hub meters', () => {
    expect(accountCount(null, pace)).toBe(2);
    expect(accountCount({ error: 'down' }, null)).toBe(0);
  });
});

describe('hotDecision', () => {
  const accounts = readProxyAccounts(profiles, NOW)!.accounts;
  test('the account in use at 86% of the week, and the next ready one to switch to', () => {
    const d = hotDecision(accounts, 80)!;
    expect(d.account.name).toBe('auto-1');
    expect(d).toMatchObject({ window: 'week', pct: 86, resetsAtMs: (S(NOW + 86_400_000)) * 1000 });
    // auto-2 is over its cap and auto-3 off, auto-4 expired: nobody ready to take over.
    expect(d.switchTo).toBeNull();
  });
  test('a ready account is offered; below the threshold nothing is asked', () => {
    const ready = accounts.map((a) => (a.name === 'auto-2' ? { ...a, state: 'ready' as const } : a));
    expect(hotDecision(ready, 80)!.switchTo?.name).toBe('auto-2');
    expect(hotDecision(accounts, 90)).toBeNull();
  });
  test('the five hours when hotter than the week', () => {
    const five = accounts.map((a) => (a.active ? { ...a, fiveH: { pct: 95, resetsAtMs: 1 } } : a));
    expect(hotDecision(five, 80)).toMatchObject({ window: 'fiveH', pct: 95, resetsAtMs: 1 });
  });
});

describe('locale', () => {
  test('the Italian article before a share: all\'86%, al 92%', () => {
    expect([1, 8, 11, 80, 86, 89].every(elidesArticle)).toBe(true);
    expect([2, 10, 18, 79, 90, 92, 100].some(elidesArticle)).toBe(false);
    expect(ACCOUNTS_IT['accounts.decide.titleElided']).toBe('{name} è all\'{pct}% {window}');
    expect(ACCOUNTS_IT['accounts.decide.title']).toBe('{name} è al {pct}% {window}');
  });
  test('the hub\'s prose: comma decimals in Italian, not shown in English', () => {
    expect(hubProse('45% usato, 9.3%/giorno, ritmo 1.7', 'it')).toBe('45% usato, 9,3%/giorno, ritmo 1,7');
    expect(hubProse('45% usato', 'en')).toBeNull();
    expect(hubProse(null, 'it')).toBeNull();
  });
  test('one decimal the locale\'s way', () => {
    expect(oneDecimal(2.94, 'it')).toBe('2,9');
    expect(oneDecimal(2.94, 'en')).toBe('2.9');
  });
});

describe('commandRequest', () => {
  test('every account command goes to the Claude proxy', () => {
    const cmds = [
      commandRequest({ kind: 'switch', name: 'auto-2' }),
      commandRequest({ kind: 'refresh', name: 'auto-4' }),
      commandRequest({ kind: 'remove', name: 'auto-4' }),
      commandRequest({ kind: 'priority', name: 'auto-2', priority: 6 }),
      commandRequest({ kind: 'enabled', name: 'auto-3', enabled: true }),
      commandRequest({ kind: 'cap', name: 'auto-2', fiveH: null, sevenD: 70 }),
      commandRequest({ kind: 'key', name: 'k-low', disabled: true }),
      commandRequest({ kind: 'setting', patch: { usageCap7d: 90 } }),
    ];
    expect(cmds.every((c) => c.path.startsWith('/api/switchboard/'))).toBe(true);
    expect(cmds[0]).toEqual({ path: '/api/switchboard/switch', method: 'POST', body: { name: 'auto-2' } });
    expect(cmds[5]).toEqual({ path: '/api/switchboard/account-cap', method: 'POST', body: { name: 'auto-2', fiveH: null, sevenD: 70 } });
    expect(cmds[6]).toEqual({ path: '/api/switchboard/api-profiles', method: 'PATCH', body: { name: 'k-low', disabled: true } });
    expect(cmds[7]).toEqual({ path: '/api/switchboard/settings', method: 'POST', body: { usageCap7d: 90 } });
  });

  test('the unlock and the background stop are the hub\'s, with the author', () => {
    expect(commandRequest({ kind: 'unlock', provider: 'codex', hours: 2 })).toMatchObject({ path: '/api/hub/override', method: 'POST', body: { provider: 'codex', hours: 2, by: 'topics' } });
    expect(commandRequest({ kind: 'relock', provider: 'muse' })).toEqual({ path: '/api/hub/override?provider=muse', method: 'DELETE' });
    expect(commandRequest({ kind: 'hold', hours: 4 })).toMatchObject({ path: '/api/hub/hold', method: 'POST', body: { hours: 4 } });
    expect(commandRequest({ kind: 'release' })).toEqual({ path: '/api/hub/hold', method: 'DELETE' });
  });
});

describe('highestQuota', () => {
  const pace = [
    { provider: 'claude', account: 'lavoro@example.com', active: true, used: 86, fiveHour: { used: 42 } },
    { provider: 'claude', account: 'finito@example.com', active: false, used: 100 },
    { provider: 'codex', account: 'codex@example.com', active: true, used: 30, fiveHour: { used: 91 } },
  ];

  test('the highest window of a plan in use, the five hours when they lead', () => {
    expect(highestQuota(pace, it)).toEqual({ pct: 91, text: '5h 91%', title: 'Quota più calda: Codex codex@example.com, 5 ore 91%' });
  });

  test('a spent account that is not in use is no signal', () => {
    expect(highestQuota(pace.slice(0, 2), it)?.text).toBe('sett. 86%');
  });

  test('below 80% and without the hub the card says nothing', () => {
    expect(highestQuota([{ provider: 'claude', active: true, used: 79, fiveHour: null }], it)).toBeNull();
    expect(highestQuota(undefined, it)).toBeNull();
  });
});

describe('profileDoor', () => {
  const hot = [{ provider: 'claude', account: 'lavoro@example.com', active: true, used: 86, fiveHour: { used: 42 } }];

  test('from 80% the phone door carries the figure alone, and its name says the rest', () => {
    expect(profileDoor('Ada Lovelace', hot, it)).toEqual({
      chip: '86%',
      title: 'Ada Lovelace. Profilo e statistiche. Quota più calda: Claude lavoro@example.com, settimana 86%',
    });
  });

  test('below 80%, without the hub or without a name, no chip and the plain name', () => {
    expect(profileDoor('Ada Lovelace', [{ ...hot[0], used: 79 }], it)).toEqual({ chip: null, title: 'Ada Lovelace. Profilo e statistiche' });
    expect(profileDoor(null, undefined, it)).toEqual({ chip: null, title: 'Profilo e statistiche' });
  });
});

describe('the view\'s strings', () => {
  test('the two languages carry the same keys', () => {
    expect(Object.keys(ACCOUNTS_EN).sort()).toEqual(Object.keys(ACCOUNTS_IT).sort());
  });
});
