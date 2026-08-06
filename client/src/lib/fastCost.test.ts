import { describe, it, expect } from 'bun:test';
import { fastCost, formatMultiplier } from './fastCost';
import type { ProvidersSnapshot } from '../types';

/**
 * Gli attesi sono COSTANTI scritte a mano, non derivate dalla tabella: se
 * qualcuno cambia un prezzo, questi test devono ROMPERSI e farlo notare — è la
 * stessa regola di `server/usage/pricing.test.ts`.
 *
 * Listino usato: opus-5 5$/25$ · sonnet-5 3$/15$ · haiku-4-5 1$/5$ ·
 * gpt-4o 2,50$/10$ · gpt-4o-mini 0,15$/0,60$ (USD per 1M token).
 */
const snap = (entries: Array<Partial<ProvidersSnapshot['providers'][number]> & { name: string }>, defaultProvider = 'claude-code'): ProvidersSnapshot => ({
  providers: entries.map((e) => ({
    status: 'ready' as const,
    isDefault: e.name === defaultProvider,
    models: [],
    requirements: [],
    fetchedAt: '2026-08-06T00:00:00.000Z',
    ...e,
  })),
  defaultProvider,
  generatedAt: '2026-08-06T00:00:00.000Z',
});

describe('fastCost', () => {
  it('opus → haiku costa un quinto', () => {
    const got = fastCost({
      snapshot: snap([{ name: 'claude-code', defaultModel: 'claude-opus-5', fastModel: 'claude-haiku-4-5' }]),
    });
    expect(got?.ratio).toBeCloseTo(0.2, 10); // 5$/25$ → 1$/5$
    expect(got?.pinned).toBe(false);
    expect(got?.spread).toBe(0); // input e output scalano insieme
  });

  it('sonnet → haiku costa un terzo', () => {
    const got = fastCost({
      snapshot: snap([{ name: 'claude-code', defaultModel: 'claude-sonnet-5', fastModel: 'claude-haiku-4-5' }]),
    });
    expect(got?.ratio).toBeCloseTo(1 / 3, 10);
  });

  it('gpt-4o → mini costa il 6%', () => {
    const got = fastCost({
      snapshot: snap([{ name: 'openai', defaultModel: 'gpt-4o', fastModel: 'gpt-4o-mini' }], 'openai'),
    });
    expect(got?.ratio).toBeCloseTo(0.06, 10); // 10$ → 0,60$
  });

  it('il suffisso di finestra non cambia il prezzo', () => {
    const got = fastCost({
      snapshot: snap([{ name: 'claude-code', defaultModel: 'claude-opus-5[1m]', fastModel: 'claude-haiku-4-5' }]),
    });
    expect(got?.ratio).toBeCloseTo(0.2, 10);
  });

  it('un modello FISSATO vince sul Fast: 1×, e lo dichiara', () => {
    // È la regola di server/routes/chat.ts: con un modello esplicito il Fast
    // non tocca niente. Promettere un risparmio qui sarebbe una bugia.
    const got = fastCost({
      snapshot: snap([{ name: 'claude-code', defaultModel: 'claude-opus-5', fastModel: 'claude-haiku-4-5' }]),
      providerOverride: { provider: 'claude-code', model: 'claude-opus-5' },
    });
    expect(got?.ratio).toBe(1);
    expect(got?.pinned).toBe(true);
  });

  it('il provider FISSATO decide da quale riga leggere', () => {
    const got = fastCost({
      snapshot: snap([
        { name: 'claude-code', defaultModel: 'claude-opus-5', fastModel: 'claude-haiku-4-5' },
        { name: 'openai', defaultModel: 'gpt-4o', fastModel: 'gpt-4o-mini' },
      ]),
      providerOverride: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(got?.fastModel).toBe('gpt-4o-mini');
    expect(got?.pinned).toBe(true);
  });

  it('niente numero quando non c\'è niente da dire', () => {
    // 1. provider senza fast model (openclaw delega al gateway)
    expect(fastCost({ snapshot: snap([{ name: 'openclaw', defaultModel: 'x', fastModel: null }], 'openclaw') })).toBeNull();
    // 2. campo assente (snapshot vecchio, o riga degradata)
    expect(fastCost({ snapshot: snap([{ name: 'claude-code', defaultModel: 'claude-opus-5' }]) })).toBeNull();
    // 3. modello fuori da ogni famiglia nota → nessun prezzo
    expect(fastCost({ snapshot: snap([{ name: 'claude-code', defaultModel: 'mistral-large', fastModel: 'gemini-3-flash-lite' }]) })).toBeNull();
    // 4. il default È già il fast model
    expect(fastCost({ snapshot: snap([{ name: 'claude-code', defaultModel: 'claude-haiku-4-5', fastModel: 'claude-haiku-4-5' }]) })).toBeNull();
    // 5. nessuno snapshot / provider non nello snapshot
    expect(fastCost({ snapshot: null })).toBeNull();
    expect(fastCost({ snapshot: snap([{ name: 'claude-code', fastModel: 'claude-haiku-4-5' }]), providerOverride: { provider: 'ignoto', model: 'x' } })).toBeNull();
  });
});

describe('formatMultiplier', () => {
  it('poche cifre, e il separatore della lingua', () => {
    expect(formatMultiplier(0.2, 'it-IT')).toBe('0,2×');
    expect(formatMultiplier(0.2, 'en-US')).toBe('0.2×');
    expect(formatMultiplier(1, 'it-IT')).toBe('1×');
    expect(formatMultiplier(1 / 3, 'en-US')).toBe('0.3×');
  });

  it('sotto il decimo aggiunge una cifra invece di dire «0,1×»', () => {
    expect(formatMultiplier(0.06, 'en-US')).toBe('0.06×');
    expect(formatMultiplier(0.06, 'it-IT')).toBe('0,06×');
  });

  it('sopra 1 resta corto', () => {
    expect(formatMultiplier(2.5, 'en-US')).toBe('2.5×');
    expect(formatMultiplier(3, 'en-US')).toBe('3×');
  });
});
