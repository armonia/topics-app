/** @covers MP-TASK-01, MP-TASK-02, MSEL-06 */
import { describe, expect, test } from 'bun:test';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from './types';
import { availableTaskModels, effectiveTopicsRouting, isTopicsModelServed, reusedSessionRouteConflict, reusedSessionRouting, TOPICS_ROUTING_DEFAULT, topicsRoute, taskExecutionOptions, taskModelMatchesSession, taskModelSelection, taskModelValue, taskProviderForModel, topicsRoutingAvailable } from './task-coding-models';

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

  // A task saved before provider prefixes names Haiku as the CLI does; the
  // engine lists it by its dated id. The switch threw "Topics routing cannot
  // dispatch" for a model the engine runs.
  test('with the switch ON a bare Claude Code alias routes to the engine that lists its dated id', () => {
    const ready = snapshot([entry('topics', ['claude-haiku-4-5-20251001'])]);
    expect(taskProviderForModel('claude-haiku-4-5', ready, true)).toBe('topics');
  });

  test('requisito #4: isTopicsModelServed e\' l\'unico helper del mezzo modello, condiviso col lato chat', () => {
    // Assente = motore non ancora raggiunto: permissivo, mai piu' severo per un dato che manca. allow-italian: la scelta su cosa fare quando la lista manca
    expect(isTopicsModelServed('claude-opus-5', undefined)).toBe(true);
    expect(isTopicsModelServed(null, undefined)).toBe(true);
    expect(isTopicsModelServed('claude-opus-5', ['claude-opus-5'])).toBe(true);
    expect(isTopicsModelServed('claude-sonnet-5', ['claude-opus-5'])).toBe(false);
    expect(isTopicsModelServed(null, ['claude-opus-5'])).toBe(true);
  });

  // A plain model only the engine serves, and the legacy `topics:<model>`,
  // resolve to the engine itself. The dispatcher runs them with the switch ON;
  // the menu called them unroutable, because `topics` is no target the engine reaches.
  test('the engine named as the target routes what it serves, while it is ready', () => {
    const engine = entry('topics', ['claude-opus-5']);
    expect(topicsRoutingAvailable('topics', 'claude-opus-5', snapshot([engine]))).toBe(true);
    expect(topicsRoutingAvailable('topics', null, snapshot([engine]))).toBe(true);
    expect(topicsRoutingAvailable('topics', 'claude-sonnet-5', snapshot([engine]))).toBe(false);
    expect(topicsRoutingAvailable('topics', 'claude-opus-5', snapshot([entry('topics', ['claude-opus-5'], 'error')]))).toBe(false);
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
    // A topic bound to the engine is a Claude Code session only with the switch ON.
    expect(taskModelMatchesSession('claude-code:claude-opus-5', { provider: 'topics', model: 'claude-opus-5', topicsRouting: true }, true)).toBe(true);
    expect(taskModelMatchesSession('claude-code:claude-opus-5', { provider: 'topics', model: 'claude-opus-5', topicsRouting: false }, true)).toBe(false);
    expect(taskModelMatchesSession('jcode:claude-opus-5', { provider: 'topics', model: 'claude-opus-5', topicsRouting: true }, true)).toBe(false);
    expect(taskModelMatchesSession('gpt-5.4', null)).toBe(false);
    expect(taskModelMatchesSession(undefined, { provider: 'codex', model: 'gpt-5.4' })).toBe(true);
  });
  // S1 and S3 on a reused session: the topic keeps its own switch, so the
  // dependent continues it only with that same switch, whatever it names.
  test('a dependent continues a session only with the switch the session runs with', () => {
    const claudeCode = (topicsRouting: boolean) => ({ provider: 'claude-code', model: 'claude-opus-5', topicsRouting });
    const engine = (topicsRouting: boolean) => ({ provider: 'topics', model: 'claude-opus-5', topicsRouting });
    const codex = { provider: 'codex', model: 'gpt-5.4' };
    // Automatic, a bare model, an explicit provider and the legacy prefix alike.
    for (const value of [undefined, 'claude-opus-5', 'claude-code:claude-opus-5', 'topics:claude-opus-5']) {
      for (const session of [claudeCode(true), engine(true)]) {
        expect(reusedSessionRouteConflict(value, session, false)).toBe('switch-on');
        expect(taskModelMatchesSession(value, session, false)).toBe(false);
      }
      for (const session of [claudeCode(false), engine(false), codex]) {
        expect(reusedSessionRouteConflict(value, session, true)).toBe('switch-off');
        expect(taskModelMatchesSession(value, session, true)).toBe(false);
      }
    }
    // The legacy prefix reads as ON while the task's own switch was never set.
    expect(reusedSessionRouteConflict('topics:claude-opus-5', engine(false), undefined)).toBe('switch-off');
    expect(reusedSessionRouteConflict('topics:claude-opus-5', engine(true), undefined)).toBeNull();
    // Both OFF, an explicit provider names who runs the turn: the engine itself or a provider directly.
    expect(reusedSessionRouteConflict('claude-code:claude-opus-5', engine(false), false)).toBe('engine');
    expect(reusedSessionRouteConflict('topics:claude-opus-5', claudeCode(false), false)).toBe('direct');
    // The same switch and the same runtime on both sides.
    expect(taskModelMatchesSession('claude-code:claude-opus-5', claudeCode(false), false)).toBe(true);
    expect(taskModelMatchesSession('claude-code:claude-opus-5', claudeCode(true), true)).toBe(true);
    expect(taskModelMatchesSession('claude-code:claude-opus-5', engine(true), true)).toBe(true);
    expect(taskModelMatchesSession('topics:claude-opus-5', engine(false), false)).toBe(true);
    expect(taskModelMatchesSession('codex:gpt-5.4', codex, false)).toBe(true);
    for (const value of [undefined, 'claude-opus-5']) {
      expect(taskModelMatchesSession(value, claudeCode(true), true)).toBe(true);
      expect(taskModelMatchesSession(value, engine(false), false)).toBe(true);
    }
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

  test('ON with a non-routable explicit provider (Codex) runs it direct, never a block', () => {
    // Codex is categorically outside the native engine's reach. The switch no
    // longer refuses it: the route is declared ("via Codex"), the turn runs.
    const current = snapshot([entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])], 'codex');
    expect(taskProviderForModel('gpt-5.4', current, false)).toBe('codex');
    expect(taskProviderForModel('gpt-5.4', current)).toBe('codex');
    expect(taskProviderForModel('gpt-5.4', current, true)).toBe('codex');
  });

  test('Automatico + ON follows the Codex default first, then decides the route', () => {
    const current = snapshot([entry('topics', ['claude-opus-5']), entry('codex', ['gpt-5.4'])], 'codex');
    expect(taskProviderForModel(undefined, current, true)).toBe('codex');
    // With a Claude default the same Automatic goes through the engine.
    const claude = snapshot([entry('topics', ['claude-opus-5']), entry('claude-code', ['claude-opus-5'])], 'claude-code');
    expect(taskProviderForModel(undefined, claude, true)).toBe('topics');
  });

  test('Automatico + ON with no native engine runs the default direct', () => {
    const current = snapshot([entry('codex', ['gpt-5.4'])], 'codex');
    expect(taskProviderForModel(undefined, current, true)).toBe('codex');
  });

  test('simmetria col lato chat: ON controlla il modello anche senza provider pinnato, e va diretto se il motore non lo serve', () => {
    // Il gemello del caso chat in resolve-topic-provider.test.ts. allow-italian: dice perche' il caso esiste due volte
    const current = snapshot([entry('topics', ['claude-opus-5']), entry('claude-code', ['claude-opus-5', 'claude-sonnet-5'])], 'claude-code');
    expect(taskProviderForModel('claude-opus-5', current, true)).toBe('topics');
    expect(taskProviderForModel('claude-sonnet-5', current, true)).toBe('claude-code');
    expect(taskProviderForModel('claude-sonnet-5', current, false)).toBe('claude-code');
  });
});

/** The catalogs measured on 2026-10-02: Claude Code's 11 ids, the engine's 14,
 *  Codex's 8 visible. MSEL-06 / tasks 1.1. */
const CLAUDE_CODE_IDS = [
  'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-4-5',
  'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]', 'claude-haiku-3-5',
];
const ENGINE_IDS = [
  'claude-opus-5-5[1m]', 'claude-opus-5-5', 'claude-opus-5[1m]', 'claude-opus-5', 'claude-sonnet-5-5[1m]', 'claude-sonnet-5-5',
  'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8[1m]', 'claude-opus-4-8', 'claude-opus-4-6',
  'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
];
const CODEX_IDS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

describe('topicsRoute, the one reading of the preference', () => {
  const fleet = (engine: ProviderSnapshotEntry['status'] = 'ready', defaultProvider = 'claude-code') => snapshot([
    entry('topics', engine === 'ready' ? ENGINE_IDS : [], engine),
    entry('claude-code', CLAUDE_CODE_IDS),
    entry('codex', CODEX_IDS),
  ], defaultProvider);
  const target = (value: string) => {
    const s = taskModelSelection(value);
    return { provider: s.provider ?? null, model: s.model ?? null };
  };

  test('TOPICS_ROUTING_DEFAULT: ON for chats, OFF for cards and the board default', () => {
    expect(TOPICS_ROUTING_DEFAULT).toEqual({ chat: true, task: false });
  });
  test('chat, null, claude-code:claude-opus-5-5: topics', () => {
    expect(topicsRoute(null, target('claude-code:claude-opus-5-5'), fleet(), 'chat')).toEqual({ via: 'topics' });
  });
  test('chat, null, codex:gpt-6.1-sol: direct/family', () => {
    expect(topicsRoute(null, target('codex:gpt-6.1-sol'), fleet(), 'chat')).toEqual({ via: 'direct', reason: 'family' });
  });
  test('chat, false: direct/off', () => {
    expect(topicsRoute(false, target('claude-code:claude-opus-5-5'), fleet(), 'chat')).toEqual({ via: 'direct', reason: 'off' });
  });
  test('chat, null, claude-code:claude-haiku-3-5: direct/model', () => {
    expect(topicsRoute(null, target('claude-code:claude-haiku-3-5'), fleet(), 'chat')).toEqual({ via: 'direct', reason: 'model' });
  });
  test('chat in Automatic, null, default codex: direct/family (the default is resolved first)', () => {
    const current = fleet('ready', 'codex');
    expect(topicsRoute(null, { provider: current.defaultProvider, model: null }, current, 'chat')).toEqual({ via: 'direct', reason: 'family' });
  });
  test('chat in Automatic, null, default claude-code: topics', () => {
    const current = fleet('ready', 'claude-code');
    expect(topicsRoute(null, { provider: current.defaultProvider, model: null }, current, 'chat')).toEqual({ via: 'topics' });
  });
  test('card, null, claude-code:claude-opus-5-5: direct/off', () => {
    expect(topicsRoute(null, target('claude-code:claude-opus-5-5'), fleet(), 'task')).toEqual({ via: 'direct', reason: 'off' });
  });
  test('card, true, codex:gpt-6.1-sol: direct/family', () => {
    expect(topicsRoute(true, target('codex:gpt-6.1-sol'), fleet(), 'task')).toEqual({ via: 'direct', reason: 'family' });
  });
  test('card in Automatic with the engine loading: pending', () => {
    const current = fleet('loading');
    expect(topicsRoute(true, { provider: taskProviderForModel(undefined, { ...current, providers: current.providers.filter(p => p.name !== 'topics') }), model: null }, current, 'task')).toEqual({ via: 'pending' });
  });
  test('null with the legacy topics:claude-opus-5: topics', () => {
    expect(topicsRoute(null, target('topics:claude-opus-5'), fleet(), 'task', 'topics:claude-opus-5')).toEqual({ via: 'topics' });
    expect(topicsRoute(null, target('topics:claude-opus-5'), fleet(), 'chat', 'topics:claude-opus-5')).toEqual({ via: 'topics' });
  });
  test('the engine down in a chat is direct/engine-down, never pending', () => {
    expect(topicsRoute(true, target('claude-code:claude-opus-5-5'), fleet('error'), 'chat')).toEqual({ via: 'direct', reason: 'engine-down' });
    expect(topicsRoute(true, target('claude-code:claude-opus-5-5'), fleet('loading'), 'chat')).toEqual({ via: 'direct', reason: 'engine-down' });
  });
  test('effectiveTopicsRouting reads a never-written value with the scope default, a written one as written', () => {
    expect(effectiveTopicsRouting(null, null, 'chat')).toBe(true);
    expect(effectiveTopicsRouting(undefined, 'claude-opus-5-5', 'task')).toBe(false);
    expect(effectiveTopicsRouting(false, null, 'chat')).toBe(false);
    expect(effectiveTopicsRouting(true, null, 'task')).toBe(true);
  });
  test('reuse: a never-written card adopts the session switch, a written one defends its own', () => {
    expect(reusedSessionRouting('claude-code:claude-opus-5-5', { topicsRouting: false }, null)).toBe(false);
    expect(reusedSessionRouting('claude-code:claude-opus-5-5', { topicsRouting: true }, null)).toBe(true);
    expect(reusedSessionRouting('claude-code:claude-opus-5-5', { topicsRouting: null }, null)).toBe(false);
    expect(reusedSessionRouting('claude-code:claude-opus-5-5', { topicsRouting: false }, true)).toBe(true);
    expect(reusedSessionRouteConflict('claude-code:claude-opus-5-5', { provider: 'claude-code', topicsRouting: false }, null)).toBeNull();
    expect(reusedSessionRouteConflict('claude-code:claude-opus-5-5', { provider: 'claude-code', topicsRouting: false }, true)).toBe('switch-off');
  });
});
