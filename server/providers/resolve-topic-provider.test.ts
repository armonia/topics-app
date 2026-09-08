/** @covers MP-TASK-01 */
import { describe, expect, test } from 'bun:test';
import { resolveTopicProvider } from './resolve-topic-provider';
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
});
