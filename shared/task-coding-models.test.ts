/** @covers MP-TASK-01 */
import { describe, expect, test } from 'bun:test';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from './types';
import { availableTaskModels, taskModelMatchesSession, taskModelSelection, taskProviderForModel } from './task-coding-models';

function entry(name: string, models: string[], status: ProviderSnapshotEntry['status'] = 'ready'): ProviderSnapshotEntry {
  return { name, models, status, isDefault: false, requirements: [], fetchedAt: '2026-09-08T00:00:00Z' };
}
function snapshot(providers: ProviderSnapshotEntry[], defaultProvider: string | null = 'topics'): ProvidersSnapshot {
  return { providers, defaultProvider, generatedAt: '2026-09-08T00:00:00Z' };
}

describe('task coding models', () => {
  test('native Claude remains selectable with no Claude CLI installed', () => {
    expect(availableTaskModels(snapshot([entry('topics', ['claude-opus-5', 'claude-sonnet-5'])])))
      .toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
  test('deduplicates Claude catalogs and includes ready Codex models with routing hints', () => {
    expect(availableTaskModels(snapshot([
      entry('topics', ['claude-opus-5']), entry('claude-code', ['claude-opus-5', 'claude-sonnet-5']),
      entry('codex', ['gpt-5.4', 'o3']),
    ]))).toEqual(['claude-opus-5', 'claude-sonnet-5', 'gpt-5.4', 'codex:o3']);
  });
  test('API chat models and unready coding providers never enter task menus', () => {
    expect(availableTaskModels(snapshot([
      entry('openai', ['gpt-5.4']), entry('claude', ['claude-opus-5']),
      entry('codex', ['gpt-5.4'], 'error'), entry('topics', ['claude-sonnet-5'], 'unavailable'),
    ]))).toEqual([]);
  });
  test('Codex can use its account default when its ready catalog is empty', () => {
    expect(availableTaskModels(snapshot([entry('codex', [])]))).toEqual(['codex']);
    expect(availableTaskModels(null)).toEqual([]);
  });
  test('a jcode GPT catalog does not claim the unavailable Codex route', () => {
    expect(availableTaskModels(snapshot([entry('jcode', ['claude-opus-5', 'gpt-5.4'])])))
      .toEqual(['claude-opus-5']);
  });
  test('explicit GPT and Codex models keep their exact upstream id', () => {
    expect(taskModelSelection('gpt-5.4')).toEqual({ provider: 'codex', model: 'gpt-5.4' });
    expect(taskModelSelection('codex:o3')).toEqual({ provider: 'codex', model: 'o3' });
    expect(taskModelSelection('codex')).toEqual({ provider: 'codex' });
    expect(taskProviderForModel('gpt-5.4', snapshot([entry('codex', ['gpt-5.4'])]))).toBe('codex');
    expect(() => taskProviderForModel('gpt-5.4', snapshot([]))).toThrow('Codex is unavailable');
  });
  test('auto leaves the model unset while choosing only a ready coding runtime', () => {
    for (const value of [null, undefined, '', 'auto']) {
      expect(taskModelSelection(value)).toEqual({});
      expect(taskProviderForModel(value, snapshot([entry('codex', ['gpt-5.4'])]))).toBe('codex');
    }
    const entries = [entry('openai', ['gpt-5.4']), entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])];
    expect(taskProviderForModel(undefined, snapshot(entries, 'openai'))).toBe('topics');
    expect(taskProviderForModel(undefined, snapshot(entries, 'codex'))).toBe('codex');
    expect(() => taskProviderForModel(undefined, snapshot([entry('openai', ['gpt-5.4'])], 'openai')))
      .toThrow('No coding agent is available');
  });
  test('an explicit Claude model uses the current coding runtime when supported', () => {
    const entries = [entry('topics', ['claude-opus-5']), entry('claude-code', ['claude-opus-5'])];
    expect(taskProviderForModel('claude-opus-5', snapshot(entries, 'claude-code'))).toBe('claude-code');
    expect(taskProviderForModel('claude-opus-5', snapshot(entries, 'openai'))).toBe('topics');
    expect(taskProviderForModel('claude-opus-5', snapshot([entry('topics', ['claude-opus-5'])]))).toBe('topics');
  });
  test('an explicit unsupported model never falls back to an API-chat default or a different coding model', () => {
    for (const providers of [
      [entry('openai', ['gpt-5.4'])],
      [entry('claude', ['claude-opus-5'])],
      [entry('topics', ['claude-opus-5'], 'unavailable')],
      [entry('topics', ['claude-sonnet-5'])],
      [entry('codex', ['gpt-5.4'])],
    ]) expect(() => taskProviderForModel('claude-opus-5', snapshot(providers, 'openai')))
      .toThrow('No coding agent is available for model');
  });
  test('reused sessions must match both the requested model and its coding runtime', () => {
    expect(taskModelMatchesSession('gpt-5.4', { provider: 'codex', model: 'gpt-5.4' })).toBe(true);
    expect(taskModelMatchesSession('codex:o3', { provider: 'codex', model: 'o3' })).toBe(true);
    expect(taskModelMatchesSession('codex', { provider: 'codex', model: 'gpt-5.4' })).toBe(true);
    expect(taskModelMatchesSession('gpt-5.4', { provider: 'openai', model: 'gpt-5.4' })).toBe(false);
    expect(taskModelMatchesSession('gpt-5.4', { provider: 'codex', model: 'gpt-5.3' })).toBe(false);
    expect(taskModelMatchesSession('claude-opus-5', { provider: 'topics', model: 'claude-opus-5' })).toBe(true);
    expect(taskModelMatchesSession('claude-opus-5', { provider: 'claude', model: 'claude-opus-5' })).toBe(false);
    expect(taskModelMatchesSession('gpt-5.4', null)).toBe(false);
    expect(taskModelMatchesSession(undefined, { provider: 'codex', model: 'gpt-5.4' })).toBe(true);
  });
  test('auto reuse still requires a known coding runtime', () => {
    for (const provider of ['topics', 'claude-code', 'claude-code-team', 'jcode', 'codex']) {
      expect(taskModelMatchesSession(undefined, { provider })).toBe(true);
    }
    for (const provider of ['openai', 'claude', 'openclaw', null, undefined]) {
      expect(taskModelMatchesSession(undefined, { provider })).toBe(false);
    }
    expect(taskModelMatchesSession(undefined, null)).toBe(false);
  });
});
