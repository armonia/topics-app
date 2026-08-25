/**
 * The effort scale the server accepts, and which provider actually serves a
 * turn: an explicit override first, then the topic's, then the registry default.
 *
 * @covers CHAT-DEF-02
 */
import { describe, it, expect } from 'bun:test';
import {
  EFFORT_TIERS,
  effortIndex,
  providerEffortTier,
  resolveEffectiveProvider,
} from './effortTiers';
import type { ProviderSnapshotEntry } from '../types';

const entry = (over: Partial<ProviderSnapshotEntry> & { name: string }): ProviderSnapshotEntry =>
  ({ status: 'ready', models: ['m1'], ...over }) as ProviderSnapshotEntry;

describe('EFFORT_TIERS', () => {
  it('è la scala ordinata che il server accetta (migration 033)', () => {
    expect([...EFFORT_TIERS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('effortIndex dà la posizione, -1 per un tier che non esiste', () => {
    expect(effortIndex('low')).toBe(0);
    expect(effortIndex('max')).toBe(4);
    expect(effortIndex('turbo')).toBe(-1);
    expect(effortIndex(null)).toBe(-1);
    expect(effortIndex(undefined)).toBe(-1);
  });
});

describe('resolveEffectiveProvider', () => {
  const entries = [
    entry({ name: 'openclaw', status: 'error', models: ['oc'] }),
    entry({ name: 'claude-code', models: ['opus', 'sonnet'] }),
    entry({ name: 'codex', isDefault: true, models: ['gpt-5-codex'] }),
  ];

  it('l\'override esplicito vince su tutto', () => {
    expect(resolveEffectiveProvider(entries, { provider: 'x', model: 'y' })).toEqual({ provider: 'x', model: 'y' });
  });

  it('poi il provider di default della topic', () => {
    expect(resolveEffectiveProvider(entries, null, 'claude-code')).toEqual({ provider: 'claude-code', model: 'opus' });
  });

  it('poi il provider marcato isDefault, poi il primo pronto', () => {
    expect(resolveEffectiveProvider(entries, null)).toEqual({ provider: 'codex', model: 'gpt-5-codex' });
    const noDefault = entries.map((e) => ({ ...e, isDefault: false }));
    expect(resolveEffectiveProvider(noDefault, null)).toEqual({ provider: 'claude-code', model: 'opus' });
  });

  it('i provider non pronti non contano — nemmeno se sono il default della topic', () => {
    expect(resolveEffectiveProvider(entries, null, 'openclaw')).toEqual({ provider: 'codex', model: 'gpt-5-codex' });
  });

  it('il default DICHIARATO dal provider batte il primo della lista', () => {
    // Il caso vero: la lista guida con l'id nudo (200k) ma lo spawn parte sul
    // gemello a finestra lunga. Dedurre il default da `models[0]` faceva
    // scrivere 200k sul badge di una sessione da un milione.
    const withDefault = [
      entry({
        name: 'claude-code',
        isDefault: true,
        models: ['claude-opus-5', 'claude-opus-5[1m]'],
        defaultModel: 'claude-opus-5[1m]',
      }),
    ];
    expect(resolveEffectiveProvider(withDefault, null))
      .toEqual({ provider: 'claude-code', model: 'claude-opus-5[1m]' });
  });

  it('null se nessun provider pronto ha modelli', () => {
    expect(resolveEffectiveProvider([entry({ name: 'a', models: [] })], null)).toBeNull();
    expect(resolveEffectiveProvider([], null)).toBeNull();
  });
});

describe('providerEffortTier', () => {
  const entries = [
    entry({ name: 'claude-code', effortTier: 'xhigh' }),
    entry({ name: 'codex' }),
  ];

  it('legge il tier del provider attivo', () => {
    expect(providerEffortTier(entries, { provider: 'claude-code', model: 'opus' }, null)).toBe('xhigh');
  });

  it('null per un provider senza tier', () => {
    expect(providerEffortTier(entries, { provider: 'codex', model: 'm1' }, null)).toBeNull();
  });

  it('senza selezione effettiva ricade sull\'override', () => {
    expect(providerEffortTier(entries, null, { provider: 'claude-code', model: 'opus' })).toBe('xhigh');
    expect(providerEffortTier(entries, null, null)).toBeNull();
  });
});
