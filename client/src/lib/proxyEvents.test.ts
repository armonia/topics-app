/**
 * The Claude proxy's activity log as the bell's History reads it: every type
 * the hub's Activity page named, in the same words and the same severity,
 * the account's label for its file name, and a fallback for a type nobody
 * named yet. The sentences are read from the Italian catalogue, so a key
 * missing from it is red here.
 * @covers HUBBR-07
 */
import { describe, expect, test } from 'bun:test';
import { PROXY_EVENT_TYPES, describeProxyEvent, proxyEvents, proxyText, type ProxyEvent } from './proxyEvents';
import PROXY_EVENTS_IT from './i18n-proxy-events-it';
import PROXY_EVENTS_EN from './i18n-proxy-events-en';

const tr = (key: string, vars?: Record<string, string | number>) => {
  const template = PROXY_EVENTS_IT[key];
  if (template === undefined) throw new Error(`missing key ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
};

const LABELS = new Map([['prof-a', 'lavoro@example.com'], ['prof-b', 'riserva@example.com']]);
const say = (e: ProxyEvent) => [proxyText(e.text, tr), e.detail ? proxyText(e.detail, tr) : null];
const one = (raw: Record<string, unknown>) => describeProxyEvent({ ts: 1, ...raw }, LABELS)!;

describe('HUBBR-07: the proxy log, every type in the hub page words', () => {
  // 29: i due tipi del vecchio gateway di Jarvis non partono più (spento il 03/11).
  test('the 29 types of the hub page are all named', () => {
    expect(PROXY_EVENT_TYPES).toHaveLength(29);
  });

  test('switches carry their mode and reason, limits their minutes, caps their names, failures their error', () => {
    expect(say(one({ type: 'auto-switch', from: 'prof-a', to: 'prof-b', reason: '429-error' }))).toEqual([
      'Cambio automatico da lavoro@example.com a riserva@example.com', 'errore 429',
    ]);
    expect(say(one({ type: 'proactive-switch', from: 'prof-a', to: 'prof-b' }))[0]).toBe('Cambio in anticipo da lavoro@example.com a riserva@example.com');
    expect(say(one({ type: 'proactive-switch', to: 'prof-b' }))[0]).toBe('Cambio in anticipo a riserva@example.com');
    expect(say(one({ type: 'manual-switch', to: 'prof-a' }))).toEqual(['Cambio manuale a lavoro@example.com', null]);
    expect(say(one({ type: 'rate-limited', account: 'prof-a', retryAfter: 600 }))).toEqual(['lavoro@example.com al limite di richieste', 'per 10 min']);
    expect(say(one({ type: 'cap-exhausted', capped: ['prof-a', 'prof-b'] }))).toEqual([
      'Tetto raggiunto su tutti gli account', 'lavoro@example.com, riserva@example.com',
    ]);
    expect(say(one({ type: 'refresh-failed', account: 'prof-b', error: 'invalid_grant' }))).toEqual(['riserva@example.com: rinnovo fallito', 'invalid_grant']);
  });

  test('the account changes the hub logged and nothing else showed: found, renamed, off, removed, priority, settings, upgrade', () => {
    expect(say(one({ type: 'account-discovered', name: 'auto-9', label: 'nuovo@example.com' }))[0]).toBe('Trovato nuovo@example.com');
    expect(say(one({ type: 'account-renamed', name: 'prof-a', label: 'casa@example.com' }))[0]).toBe('lavoro@example.com rinominato in casa@example.com');
    expect(say(one({ type: 'account-enabled', name: 'prof-b', enabled: false }))[0]).toBe('riserva@example.com spento: escluso dalla rotazione');
    expect(say(one({ type: 'account-enabled', name: 'prof-b', enabled: true }))[0]).toBe('riserva@example.com riacceso');
    expect(say(one({ type: 'account-removed', name: 'prof-b' }))[0]).toBe('riserva@example.com rimosso');
    expect(say(one({ type: 'priority-set', name: 'prof-a', priority: 2 }))[0]).toBe('lavoro@example.com: priorità impostata a 2');
    expect(say(one({ type: 'account-cap', name: 'prof-a', fiveH: 80, sevenD: 90 }))).toEqual(['lavoro@example.com: tetto cambiato', '80% sulle 5 ore, 90% sulla settimana']);
    expect(say(one({ type: 'settings-changed' }))[0]).toBe('Impostazioni del proxy cambiate');
    expect(say(one({ type: 'upgrade', to: '2.4.0' }))[0]).toBe('Proxy aggiornato a 2.4.0');
  });

  test('the severity is the hub dot of each type', () => {
    expect(one({ type: 'auto-switch' }).tone).toBe('info');
    expect(one({ type: 'rate-limited' }).tone).toBe('warn');
    expect(one({ type: 'auth-expired' }).tone).toBe('bad');
    expect(one({ type: 'token-refreshed' }).tone).toBe('ok');
    expect(one({ type: 'priority-set' }).tone).toBe('muted');
  });

  test('a type nobody named is still shown, never dropped', () => {
    const e = one({ type: 'brand_new-event' });
    expect(say(e)).toEqual(['Evento del proxy (brand new event)', null]);
    expect(e).toMatchObject({ tone: 'muted', family: 'other' });
  });

  test('the whole log, newest first, without the malformed lines; every type has its words in both languages', () => {
    const log = { log: [
      { type: 'manual-switch', ts: 10, to: 'prof-a' },
      { type: 'upgrade', ts: 30, to: '2.4.0' },
      { ts: 20 },
      'noise',
      { type: 'settings-changed', ts: 20 },
    ] };
    expect(proxyEvents(log, { profiles: [{ name: 'prof-a', label: 'lavoro@example.com' }] }).map((e) => e.type)).toEqual(['upgrade', 'settings-changed', 'manual-switch']);
    expect(proxyEvents(null, null)).toEqual([]);
    for (const type of PROXY_EVENT_TYPES) {
      const e = one({ type, account: 'prof-a', from: 'prof-a', to: 'prof-b', name: 'prof-a', retryAfter: 60, capped: ['prof-a'], status: 529, attempt: 2, consecutive: 3, cap: 4 });
      for (const t of [e.text, e.detail]) if (t && 'key' in t) expect(PROXY_EVENTS_EN[t.key]).toBeDefined();
      expect(() => say(e)).not.toThrow();
    }
    expect(Object.keys(PROXY_EVENTS_EN).sort()).toEqual(Object.keys(PROXY_EVENTS_IT).sort());
  });
});
