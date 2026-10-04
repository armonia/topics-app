/**
 * The provider, model and effort the composer remembers for a topic, so the
 * choice made once survives the next turn.
 *
 * @covers CCPROV-05
 */
import { describe, it, expect } from 'bun:test';
import {
  autonomyKey,
  effortKey,
  providerOnlyKey,
  providerOverrideKey,
  readLastProviderSelection,
  rememberAutonomySelection,
  rememberEffort,
  rememberProviderSelection,
  sameSelection,
  seedAutonomy,
  seedEffort,
  seedProviderOnly,
  seedProviderOverride,
  type KeyValueStore,
} from './composerMemory';

function fakeStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

const SONNET = { provider: 'claude-code', model: 'claude-sonnet-5' };
const CODEX = { provider: 'codex', model: 'gpt-5.5' };

describe('seedProviderOverride', () => {
  it('preferisce quello che il topic persiste sul server', () => {
    const store = fakeStore({ 'providerOverride:last': JSON.stringify(CODEX) });
    expect(seedProviderOverride({
      topicId: 't1', topicProvider: SONNET.provider, topicModel: SONNET.model, store,
    })).toEqual(SONNET);
  });

  it('una chat vecchia senza modello resta sul default, non eredita', () => {
    const store = fakeStore({ 'providerOverride:last': JSON.stringify(CODEX) });
    expect(seedProviderOverride({ topicId: 't1', store })).toBeNull();
  });

  it('provider senza modello non è un override', () => {
    const store = fakeStore();
    expect(seedProviderOverride({ topicId: 't1', topicProvider: 'codex', store })).toBeNull();
  });

  it('la bozza riprende la scelta fatta su di sé', () => {
    const store = fakeStore({
      [providerOverrideKey('draft:a')]: JSON.stringify(SONNET),
      'providerOverride:last': JSON.stringify(CODEX),
    });
    expect(seedProviderOverride({ topicId: 'draft:a', store })).toEqual(SONNET);
  });

  it('una chat nuova eredita l\'ultima scelta fatta altrove', () => {
    const store = fakeStore({ 'providerOverride:last': JSON.stringify(CODEX) });
    expect(seedProviderOverride({ topicId: 'draft:b', store })).toEqual(CODEX);
  });

  it('ignora una memoria corrotta o mezza scritta', () => {
    expect(seedProviderOverride({ topicId: 'draft:c', store: fakeStore({ 'providerOverride:last': '{oops' }) })).toBeNull();
    expect(seedProviderOverride({ topicId: 'draft:c', store: fakeStore({ 'providerOverride:last': '{"provider":"codex"}' }) })).toBeNull();
    expect(seedProviderOverride({ topicId: 'draft:c', store: fakeStore({ 'providerOverride:last': '{"provider":"","model":""}' }) })).toBeNull();
  });
});

describe('seedProviderOnly', () => {
  it('reads the engine a saved topic runs with no model', () => {
    expect(seedProviderOnly({ topicId: 't1', topicProvider: 'gemini', topicModel: null, store: fakeStore() })).toBe('gemini');
    expect(seedProviderOnly({ topicId: 't1', topicProvider: 'codex', topicModel: 'gpt-5.5', store: fakeStore() })).toBeNull();
    expect(seedProviderOnly({ topicId: 't1', store: fakeStore({ [providerOnlyKey('t1')]: 'gemini' }) })).toBeNull();
  });

  it('a draft keeps the engine it chose, and does not inherit the last model chosen elsewhere', () => {
    const store = fakeStore({ [providerOnlyKey('draft:g')]: 'gemini', 'providerOverride:last': JSON.stringify(CODEX) });
    expect(seedProviderOnly({ topicId: 'draft:g', store })).toBe('gemini');
    expect(seedProviderOverride({ topicId: 'draft:g', store })).toBeNull();
    expect(seedProviderOnly({ topicId: 'draft:h', store })).toBeNull();
  });
});

describe('rememberProviderSelection', () => {
  it('tornare al default cancella la memoria invece di lasciare il modello vecchio', () => {
    const store = fakeStore({ 'providerOverride:last': JSON.stringify(CODEX) });
    rememberProviderSelection(store, null);
    expect(readLastProviderSelection(store)).toBeNull();
    expect(seedProviderOverride({ topicId: 'draft:d', store })).toBeNull();
  });

  it('la scelta appena fatta è quella che la chat dopo eredita', () => {
    const store = fakeStore();
    rememberProviderSelection(store, CODEX);
    expect(seedProviderOverride({ topicId: 'draft:e', store })).toEqual(CODEX);
  });
});

describe('seedEffort', () => {
  it('il valore del topic vince', () => {
    const store = fakeStore({ 'effort:last': 'low' });
    expect(seedEffort({ topicId: 't1', topicEffort: 'high', store })).toBe('high');
  });

  it('la bozza riprende il suo, poi l\'ultimo usato', () => {
    const own = fakeStore({ [effortKey('draft:a')]: 'medium', 'effort:last': 'low' });
    expect(seedEffort({ topicId: 'draft:a', store: own })).toBe('medium');
    expect(seedEffort({ topicId: 'draft:z', store: own })).toBe('low');
  });

  it('una chat reale senza effort non eredita', () => {
    expect(seedEffort({ topicId: 't2', store: fakeStore({ 'effort:last': 'low' }) })).toBeNull();
  });

  it('rimettere il default cancella la memoria', () => {
    const store = fakeStore({ 'effort:last': 'low' });
    rememberEffort(store, null);
    expect(seedEffort({ topicId: 'draft:n', store })).toBeNull();
  });
});

describe('seedAutonomy', () => {
  it('il valore del topic vince', () => {
    const store = fakeStore({ 'autonomy:last': 'ask' });
    expect(seedAutonomy({ topicId: 't1', topicAutonomy: 'yolo', store })).toBe('yolo');
  });

  it('la bozza riprende la sua, poi l\'ultima usata', () => {
    const own = fakeStore({ [autonomyKey('draft:a')]: 'ask', 'autonomy:last': 'yolo' });
    expect(seedAutonomy({ topicId: 'draft:a', store: own })).toBe('ask');
    expect(seedAutonomy({ topicId: 'draft:z', store: own })).toBe('yolo');
  });

  it('una chat reale senza autonomia non eredita', () => {
    expect(seedAutonomy({ topicId: 't2', store: fakeStore({ 'autonomy:last': 'yolo' }) })).toBeNull();
  });

  it('rimettere il default cancella la memoria', () => {
    const store = fakeStore({ 'autonomy:last': 'yolo' });
    rememberAutonomySelection(store, null);
    expect(seedAutonomy({ topicId: 'draft:n', store })).toBeNull();
  });

  it('la scelta appena fatta è quella che la chat dopo eredita', () => {
    const store = fakeStore();
    rememberAutonomySelection(store, 'yolo');
    expect(seedAutonomy({ topicId: 'draft:e', store })).toBe('yolo');
  });
});

describe('sameSelection', () => {
  it('confronta i valori, non l\'identità', () => {
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection({ ...CODEX }, { ...CODEX })).toBe(true);
    expect(sameSelection(CODEX, SONNET)).toBe(false);
    expect(sameSelection(CODEX, null)).toBe(false);
  });
});
