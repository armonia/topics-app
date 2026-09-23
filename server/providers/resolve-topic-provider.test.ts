/** @covers MP-TASK-01 */
import { describe, expect, test } from 'bun:test';
import { resolveTopicProvider, TopicsRoutingIncompatibleError } from './resolve-topic-provider';
import type { AIProvider } from './types';

describe('explicit topic provider resolution', () => {
  const fallback = { name: 'topics' } as AIProvider;
  test('an unavailable pinned Codex never falls back to Claude', () => {
    let defaults = 0;
    expect(() => resolveTopicProvider({ provider: 'codex' }, {
      getProvider: () => { throw new Error('not registered'); },
      getDefaultProvider: () => { defaults++; return fallback; },
    })).toThrow('Provider "codex" non disponibile');
    expect(defaults).toBe(0);
  });
  test('keeps the registered provider and leaves its connection diagnosis intact', () => {
    const codex = { name: 'codex', connected: false } as AIProvider;
    expect(resolveTopicProvider({ provider: 'codex' }, {
      getProvider: () => codex, getDefaultProvider: () => fallback,
    })).toBe(codex);
  });
  test('preserves the legacy Claude team mapping without a fallback', () => {
    let selected = '';
    resolveTopicProvider({ provider: 'claude-code-team' }, {
      getProvider: (name) => { selected = name; return fallback; }, getDefaultProvider: () => fallback,
    });
    expect(selected).toBe('claude-code');
  });
  test('uses the default only for an unpinned conversation', () => {
    for (const topic of [null, undefined, {}, { provider: null }]) {
      expect(resolveTopicProvider(topic, {
        getProvider: () => { throw new Error('must not look up an explicit provider'); }, getDefaultProvider: () => fallback,
      })).toBe(fallback);
    }
  });

  describe('AICTRL-01 routing switch', () => {
    test('ON + routable explicit provider executes via topics, without rewriting the pinned choice', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const topic = { provider: 'claude-code', topicsRouting: true };
      const resolved = resolveTopicProvider(topic, {
        getProvider: (name) => name === 'topics' ? topicsNative : claudeCode,
        getDefaultProvider: () => fallback,
      });
      expect(resolved.name).toBe('topics');
      expect(topic.provider).toBe('claude-code'); // the switch never touches it
    });
    test('ON + a non-routable provider (Codex) never dispatches direct: explicit incompatibility, not a silent no-op', () => {
      const codex = { name: 'codex', connected: true } as AIProvider;
      let reached = false;
      expect(() => resolveTopicProvider({ provider: 'codex', topicsRouting: true }, {
        getProvider: () => { reached = true; return codex; }, getDefaultProvider: () => fallback,
      })).toThrow(TopicsRoutingIncompatibleError);
      // Never even asked the registry for codex directly: ON blocks before dispatch.
      expect(reached).toBe(false);
    });
    test('ON + non-routable provider: the thrown reason is present and readable', () => {
      const codex = { name: 'codex', connected: true } as AIProvider;
      try {
        resolveTopicProvider({ provider: 'codex', topicsRouting: true }, {
          getProvider: () => codex, getDefaultProvider: () => fallback,
        });
        throw new Error('expected resolveTopicProvider to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TopicsRoutingIncompatibleError);
        expect((err as Error).message.length).toBeGreaterThan(0);
      }
    });
    test('ON but the native engine is unavailable never falls through to the explicit provider', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      expect(() => resolveTopicProvider({ provider: 'claude-code', topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') throw new Error('not registered'); return claudeCode; },
        getDefaultProvider: () => fallback,
      })).toThrow(TopicsRoutingIncompatibleError);
    });
    test('ON but the native engine is registered yet disconnected: same explicit block', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      const topicsNative = { name: 'topics', connected: false } as AIProvider;
      expect(() => resolveTopicProvider({ provider: 'claude-code', topicsRouting: true }, {
        getProvider: (name) => name === 'topics' ? topicsNative : claudeCode,
        getDefaultProvider: () => fallback,
      })).toThrow(TopicsRoutingIncompatibleError);
    });
    test('Automatico + ON routes through the native topics engine, not the registry default', () => {
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const otherDefault = { name: 'codex' } as AIProvider;
      let defaults = 0;
      const resolved = resolveTopicProvider({ provider: null, topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
        getDefaultProvider: () => { defaults++; return otherDefault; },
      });
      expect(resolved).toBe(topicsNative);
      expect(defaults).toBe(0);
    });
    test('Automatico + ON but the native engine is unavailable: explicit incompatibility, not the registry default', () => {
      const otherDefault = { name: 'codex' } as AIProvider;
      expect(() => resolveTopicProvider({ provider: null, topicsRouting: true }, {
        getProvider: () => { throw new Error('not registered'); },
        getDefaultProvider: () => otherDefault,
      })).toThrow(TopicsRoutingIncompatibleError);
    });
    test('ON + a legacy provider:"topics" (AICTRL-04 stale value, never re-selectable) resolves via the native engine, no throw', () => {
      // "topics" non e' un bersaglio instradabile (e' il router), ma un topic vecchio gia' salvato cosi' deve solo eseguire nativo, non bloccarsi con un errore assurdo. allow-italian: il caso limite che il test difende
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const resolved = resolveTopicProvider({ provider: 'topics', topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
        getDefaultProvider: () => fallback,
      });
      expect(resolved).toBe(topicsNative);
    });
    test('Automatico + ON: il modello si controlla anche SENZA provider pinnato', () => {
      // Col `name &&` davanti, Automatico saltava il controllo e dispacciava un modello che il motore nativo non serve: il no-op silenzioso che ON deve rendere impossibile, e che il lato task non aveva. allow-italian: nomina il buco chiuso qui
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      let thrown: unknown;
      try {
        resolveTopicProvider({ provider: null, model: 'claude-sonnet-5', topicsRouting: true }, {
          getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
          getDefaultProvider: () => fallback,
          getTopicsModels: () => ['claude-opus-5'],
        });
      } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(TopicsRoutingIncompatibleError);
      expect((thrown as TopicsRoutingIncompatibleError).message).toContain('claude-sonnet-5');
    });
    test('Automatico + ON con un modello servito dal motore nativo passa', () => {
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const resolved = resolveTopicProvider({ provider: null, model: 'claude-opus-5', topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
        getDefaultProvider: () => fallback,
        getTopicsModels: () => ['claude-opus-5'],
      });
      expect(resolved).toBe(topicsNative);
    });
    test('OFF executes directly on the pinned provider, no detour through topics', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      let askedForTopics = false;
      const resolved = resolveTopicProvider({ provider: 'claude-code', topicsRouting: false }, {
        getProvider: (name) => { if (name === 'topics') askedForTopics = true; return claudeCode; },
        getDefaultProvider: () => fallback,
      });
      expect(resolved).toBe(claudeCode);
      expect(askedForTopics).toBe(false);
    });
  });
});
