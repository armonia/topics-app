/** @covers MP-TASK-01, MSEL-06 */
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
    test('ON + a non-routable provider (Codex) runs direct on it, never a block', () => {
      const codex = { name: 'codex', connected: true } as AIProvider;
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      for (const topicsRouting of [true, null]) {
        expect(resolveTopicProvider({ provider: 'codex', topicsRouting }, {
          getProvider: (name) => name === 'topics' ? topicsNative : codex, getDefaultProvider: () => fallback,
        })).toBe(codex);
      }
    });
    test('ON but the native engine is unavailable runs the explicit provider direct', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      expect(resolveTopicProvider({ provider: 'claude-code', topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') throw new Error('not registered'); return claudeCode; },
        getDefaultProvider: () => fallback,
      })).toBe(claudeCode);
    });
    test('ON but the native engine is registered yet disconnected: direct too', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      const topicsNative = { name: 'topics', connected: false } as AIProvider;
      expect(resolveTopicProvider({ provider: 'claude-code', topicsRouting: true }, {
        getProvider: (name) => name === 'topics' ? topicsNative : claudeCode,
        getDefaultProvider: () => fallback,
      })).toBe(claudeCode);
    });
    test('Automatico + ON resolves the registry default FIRST: a Codex default stays on Codex', () => {
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const codexDefault = { name: 'codex' } as AIProvider;
      const resolved = resolveTopicProvider({ provider: null, topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
        getDefaultProvider: () => codexDefault,
      });
      expect(resolved).toBe(codexDefault);
    });
    test('Automatico + ON with a Claude Code default goes through the engine', () => {
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const claudeDefault = { name: 'claude-code' } as AIProvider;
      expect(resolveTopicProvider({ provider: null, topicsRouting: null, model: 'claude-opus-5' }, {
        getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
        getDefaultProvider: () => claudeDefault,
        getTopicsModels: () => ['claude-opus-5'],
      })).toBe(topicsNative);
    });
    test('a chat on Claude Code never touched (null) runs on the engine from its next turn', () => {
      const claudeCode = { name: 'claude-code', connected: true } as AIProvider;
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const topic = { provider: 'claude-code', model: 'claude-opus-5', topicsRouting: null };
      expect(resolveTopicProvider(topic, {
        getProvider: (name) => name === 'topics' ? topicsNative : claudeCode,
        getDefaultProvider: () => fallback,
        getTopicsModels: () => ['claude-opus-5'],
      })).toBe(topicsNative);
      expect(topic.topicsRouting).toBeNull();
    });
    test('the legacy provider:"topics" with the engine down is the one explicit block left', () => {
      expect(() => resolveTopicProvider({ provider: 'topics' }, {
        getProvider: () => ({ name: 'topics', connected: false } as AIProvider),
        getDefaultProvider: () => fallback,
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
    test('ON + un modello che il motore non serve va diretto sul default, senza bloccare', () => {
      const topicsNative = { name: 'topics', connected: true } as AIProvider;
      const claudeDefault = { name: 'claude-code' } as AIProvider;
      expect(resolveTopicProvider({ provider: null, model: 'claude-sonnet-5', topicsRouting: true }, {
        getProvider: (name) => { if (name === 'topics') return topicsNative; throw new Error(`unexpected lookup: ${name}`); },
        getDefaultProvider: () => claudeDefault,
        getTopicsModels: () => ['claude-opus-5'],
      })).toBe(claudeDefault);
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
