/** @covers MP-TASK-01, MP-TASK-02 */
import { describe, expect, test } from 'bun:test';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from './types';
import { availableTaskModels, isTopicsModelServed, taskExecutionOptions, taskModelMatchesSession, taskModelSelection, taskModelValue, taskProviderForModel, TopicsRoutingUnavailableError } from './task-coding-models';

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
  test('new values bind runtime before model while legacy values remain valid', () => {
    expect(taskModelValue('topics', 'claude-opus-5')).toBe('topics:claude-opus-5');
    expect(taskModelValue('codex', null)).toBe('codex:auto');
    expect(taskModelSelection('topics:claude-opus-5')).toEqual({ provider: 'topics', model: 'claude-opus-5' });
    expect(taskModelSelection('claude-opus-5')).toEqual({ model: 'claude-opus-5' });
    expect(taskModelSelection('codex:auto')).toEqual({ provider: 'codex' });
    expect(taskModelSelection('topics:auto')).toEqual({ provider: 'topics' });
  });
  test('execution catalog trusts server coding capability and keeps unavailable rows', () => {
    const ready = { ...entry('topics', ['claude-opus-5', 'gpt-5.4']), label: 'Topics', capabilities: ['coding-tasks'] };
    const unavailable = { ...entry('codex', ['gpt-5.4'], 'unavailable'), label: 'Codex', capabilities: ['coding-tasks'], lastError: 'Sign in required' };
    const api = { ...entry('openai', ['gpt-5.4']), capabilities: ['streaming'] };
    // AICTRL-01: topics is the routing switch above this list, never a menu row.
    expect(taskExecutionOptions(snapshot([ready, unavailable, api]))).toEqual([
      { name: 'codex', label: 'Codex', status: 'unavailable', models: ['gpt-5.4'], supportsAutomatic: true, reason: 'Sign in required' },
    ]);
  });
  test('an explicit runtime never falls back to another compatible runtime', () => {
    const current = snapshot([
      entry('topics', ['claude-opus-5'], 'unavailable'),
      entry('claude-code', ['claude-opus-5']),
    ], 'claude-code');
    expect(() => taskProviderForModel('topics:claude-opus-5', current)).toThrow('topics is unavailable');
    expect(taskProviderForModel('claude-code:claude-opus-5', current)).toBe('claude-code');
    expect(taskProviderForModel('topics:auto', snapshot([entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])], 'codex'))).toBe('topics');
    expect(taskProviderForModel('codex:auto', snapshot([entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])], 'topics'))).toBe('codex');
  });
  test('requisito #9: un legacy provider:"topics" con topicsRouting=true (transizione AICTRL-04) esegue nativo senza throw', () => {
    // "topics" non e' un bersaglio instradabile (e' il router), ma un valore vecchio `topics:<model>` accende lo switch da quello stesso prefisso: quel giro deve eseguire nativo, mai esplodere. allow-italian: il caso limite che il test difende
    const ready = snapshot([entry('topics', ['claude-opus-5'])]);
    expect(taskProviderForModel('topics:claude-opus-5', ready, true)).toBe('topics');
    expect(taskProviderForModel('topics:auto', ready, true)).toBe('topics');
  });

  test('requisito #4: isTopicsModelServed e\' l\'unico helper del mezzo modello, condiviso col lato chat', () => {
    // Assente = motore non ancora raggiunto: permissivo, mai piu' severo per un dato che manca. allow-italian: la scelta su cosa fare quando la lista manca
    expect(isTopicsModelServed('claude-opus-5', undefined)).toBe(true);
    expect(isTopicsModelServed(null, undefined)).toBe(true);
    expect(isTopicsModelServed('claude-opus-5', ['claude-opus-5'])).toBe(true);
    expect(isTopicsModelServed('claude-sonnet-5', ['claude-opus-5'])).toBe(false);
    expect(isTopicsModelServed(null, ['claude-opus-5'])).toBe(true);
  });

  test('only task-capable ACP runtimes enter the catalog and legacy jcode routes stay valid', () => {
    const chatOnly = { ...entry('jcode', ['claude-opus-5']), capabilities: ['streaming'] };
    const taskCapable = { ...chatOnly, capabilities: ['streaming', 'coding-tasks'] };
    expect(taskExecutionOptions(snapshot([chatOnly]))).toEqual([]);
    expect(availableTaskModels(snapshot([chatOnly]))).toEqual([]);
    expect(() => taskProviderForModel('jcode:claude-opus-5', snapshot([chatOnly]))).toThrow('jcode is unavailable');
    expect(taskExecutionOptions(snapshot([taskCapable]))[0]?.name).toBe('jcode');
    expect(taskExecutionOptions(snapshot([taskCapable]))[0]?.supportsAutomatic).toBe(false);
    expect(taskProviderForModel('jcode:claude-opus-5', snapshot([taskCapable]))).toBe('jcode');
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
  test('a loading Codex default waits instead of selecting ready Claude', () => {
    const current = snapshot([
      entry('topics', ['claude-opus-5']), entry('codex', [], 'loading'),
    ], 'codex');
    for (const selected of [undefined, null, 'auto', 'codex', 'gpt-5.4']) {
      let failure: unknown;
      try { taskProviderForModel(selected, current); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'task_provider_pending', provider: 'codex' });
    }
    expect(taskProviderForModel('claude-opus-5', current)).toBe('topics');
  });
  test('a failed Codex default remains a constraint while explicit Claude still works', () => {
    for (const status of ['error', 'unavailable'] as const) {
      const current = snapshot([
        entry('topics', ['claude-opus-5']), entry('codex', [], status),
      ], 'codex');
      expect(() => taskProviderForModel(undefined, current)).toThrow('Codex is unavailable');
      expect(taskProviderForModel('claude-opus-5', current)).toBe('topics');
    }
  });

  test('canonical routing switch: ON reroutes an explicit routable provider through topics without touching the selection', () => {
    const entries = [entry('topics', ['claude-opus-5']), entry('claude-code', ['claude-opus-5'])];
    const current = snapshot(entries, 'claude-code');
    // ON + explicit routable provider: the turn executes via topics, targeting that provider/model.
    expect(taskProviderForModel('claude-code:claude-opus-5', current, true)).toBe('topics');
    // OFF (explicit or omitted): direct execution, no routing detour.
    expect(taskProviderForModel('claude-code:claude-opus-5', current, false)).toBe('claude-code');
    expect(taskProviderForModel('claude-code:claude-opus-5', current)).toBe('claude-code');
    // The stored/displayed selection never changes because of the switch.
    expect(taskModelSelection('claude-code:claude-opus-5')).toEqual({ provider: 'claude-code', model: 'claude-opus-5' });
  });

  test('canonical routing switch: ON with a non-routable explicit provider (Codex) hard-gates, never a silent direct dispatch', () => {
    // Codex is categorically outside the native engine's reach. ON asked for
    // routing; a silent fallback to direct execution would be exactly the
    // no-op the AICTRL-01 contract forbids on the chat side too.
    const current = snapshot([entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])], 'codex');
    expect(taskProviderForModel('gpt-5.4', current, false)).toBe('codex'); // OFF: still executes Codex direct
    expect(taskProviderForModel('gpt-5.4', current)).toBe('codex'); // omitted: same as OFF
    expect(() => taskProviderForModel('gpt-5.4', current, true)).toThrow(TopicsRoutingUnavailableError);
  });

  test('canonical routing switch: Automatico + ON dispatches via the native topics engine, beating even a Codex default', () => {
    const current = snapshot([entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])], 'codex');
    expect(taskProviderForModel(undefined, current, true)).toBe('topics');
  });

  test('canonical routing switch: Automatico + ON with no native topics catalog hard-gates instead of falling back to the default', () => {
    const current = snapshot([entry('codex', ['gpt-5.4'])], 'codex');
    expect(() => taskProviderForModel(undefined, current, true)).toThrow(TopicsRoutingUnavailableError);
  });

  test('simmetria col lato chat: Automatico + ON controlla il modello anche senza provider pinnato', () => {
    // Il gemello del caso chat in resolve-topic-provider.test.ts: qui era gia' giusto e deve restarlo, e' la sponda che dice cosa doveva fare l'altra. allow-italian: dice perche' il caso esiste due volte
    const current = snapshot([entry('topics', ['claude-opus-5']), entry('claude-code', ['claude-opus-5', 'claude-sonnet-5'])], 'claude-code');
    expect(taskProviderForModel('claude-opus-5', current, true)).toBe('topics');
    expect(() => taskProviderForModel('claude-sonnet-5', current, true)).toThrow(TopicsRoutingUnavailableError);
    // OFF lo esegue diretto: il cancello e' dello switch, non del catalogo. allow-italian: la recinzione del caso sopra
    expect(taskProviderForModel('claude-sonnet-5', current, false)).toBe('claude-code');
  });
});
