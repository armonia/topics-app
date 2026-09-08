/** @covers AGPT-01 AGPT-02 */
import { describe, expect, test } from 'bun:test';
import { pickCodingTaskPlan, TASK_CLASSIFIER_TIMEOUT_MS, type CodingModel } from './task-auto-plan';
import { pickAutomaticTaskModel, automaticTaskCatalog, automaticTaskProvider } from './task-auto-model';
import type { AIProvider, CompletionOptions } from '../providers/types';
import type { ProvidersSnapshot } from '../../shared/types';

const models: CodingModel[] = [
  { provider: 'codex', slug: 'gpt-6-astra', description: 'Most capable for demanding work', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { provider: 'codex', slug: 'gpt-5.6-sol', description: 'Reliable workhorse', defaultEffort: 'low', efforts: ['low', 'medium', 'high'] },
  { provider: 'codex', slug: 'gpt-5.6-luna', description: 'Fast and affordable', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] },
];

describe('Codex task planning', () => {
  for (const [text, model, effort, weight] of [
    ['Correct one label and its focused test', 'gpt-5.6-luna', 'low', 'light'],
    ['Implement a normal multi-file CRUD feature', 'gpt-5.6-sol', 'medium', 'light'],
    ['Resolve an ambiguous consistency failure across replicas', 'gpt-6-astra', 'high', 'light'],
    ['Run the full large browser matrix', 'gpt-5.6-sol', 'low', 'heavy'],
  ] as const) {
    test(`accepts available model/effort for: ${text}`, async () => {
      let calls = 0;
      const plan = await pickCodingTaskPlan({ text }, { models, complete: async (prompt, options) => {
        calls++;
        expect(prompt).toContain(text);
        expect(prompt).toContain('correctness requirements');
        expect(prompt).toContain('difficult reasoning alone is light');
        expect(options).toEqual({ model: 'gpt-5.6-luna', reasoningEffort: 'low', timeoutMs: TASK_CLASSIFIER_TIMEOUT_MS, isolated: true });
        return JSON.stringify({ model, effort, weight });
      } });
      expect(calls).toBe(1);
      expect(plan).toMatchObject({ model, effort, weight });
    });
  }

  for (const answer of ['bad JSON', '{"model":"claude-opus-5","effort":"medium","weight":"light"}', '{"model":"gpt-not-available","effort":"high","weight":"light"}', '{"model":"gpt-5.6-luna","effort":"ultra","weight":"light"}', '{"model":"gpt-6-astra","effort":"ultra","weight":"light"}', '{"model":"gpt-6-astra","effort":"high"}']) {
    test(`invalid response uses a logged available fallback: ${answer}`, async () => {
      const logs: string[] = [];
      const plan = await pickCodingTaskPlan({ text: 'task' }, { models, complete: async () => answer, log: m => logs.push(m) });
      expect(plan).toMatchObject({ model: 'gpt-5.6-sol', effort: 'medium', weight: null });
      expect(logs[0]).toContain('fallback');
    });
  }

  test('timeout/failure uses the same supported fallback without another classification', async () => {
    let calls = 0;
    const plan = await pickCodingTaskPlan({ text: 'task' }, { models: [models[2]!], complete: async () => { calls++; throw new Error('timeout'); } });
    expect(plan).toMatchObject({ model: 'gpt-5.6-luna', effort: 'medium', weight: null });
    expect(calls).toBe(1);
  });

  test('empty catalog cannot invent a model or call a classifier', async () => {
    await expect(pickCodingTaskPlan({ text: 'task' }, { models: [], complete: async () => { throw new Error('must not run'); } })).rejects.toThrow('No eligible coding model');
  });

  test('bounds task input, preserves it as data and supports non-GPT Codex IDs', async () => {
    const future = { ...models[2]!, slug: 'o-next-account' };
    const plan = await pickCodingTaskPlan({ text: 'T'.repeat(1000), description: 'D'.repeat(10000) }, {
      models: [future], complete: async (prompt, options) => {
        expect(options.model).toBe('o-next-account');
        expect(prompt).not.toContain('D'.repeat(4001));
        expect(prompt).not.toContain('T'.repeat(401));
        return '{"model":"o-next-account","effort":"low","weight":"light"}';
      },
    });
    expect(plan.model).toBe('codex:o-next-account');
  });
});

describe('automatic host provider routing', () => {
  const snapshot = (defaultProvider: string) => ({ defaultProvider, providers: [
    { name: 'codex', status: 'ready', models: models.map(m => m.slug) },
    { name: 'claude-code', status: 'ready', models: ['claude-opus-5'] },
  ] }) as ProvidersSnapshot;
  for (const [selection, defaultProvider] of [[undefined, 'codex'], ['codex', 'claude-code']] as const) {
    test(`Codex ${selection ?? 'default'} never uses Claude to classify`, async () => {
      const accessed: string[] = [];
      const options: CompletionOptions[] = [];
      const plan = await pickAutomaticTaskModel({ text: 'Task' }, selection, {
        snapshot: snapshot(defaultProvider), codexModels: () => models,
        getProvider: name => {
          accessed.push(name);
          if (name !== 'codex') throw new Error('Claude is held: must not be consulted');
          return { connected: true, complete: async (_messages: unknown, opts: CompletionOptions) => {
            options.push(opts); return { content: '{"model":"gpt-5.6-sol","effort":"medium","weight":"light"}' };
          } } as unknown as AIProvider;
        },
      });
      expect(plan.model).toBe('gpt-5.6-sol');
      expect(accessed).toEqual(['codex']);
      expect(options[0]?.model).toBe('gpt-5.6-luna');
    });
  }

  test('missing Codex catalog never falls back across providers', async () => {
    const accessed: string[] = [];
    await expect(pickAutomaticTaskModel({ text: 'Task' }, 'codex', {
      snapshot: snapshot('claude-code'), codexModels: () => [],
      getProvider: name => { accessed.push(name); return undefined; },
    })).rejects.toThrow('No eligible coding model');
    expect(accessed).toEqual([]);
  });
});

describe('general automatic catalog and constraints', () => {
  test('selected runtime remains Topics when an excluded ACP runtime shares the same model ID', async () => {
    const snapshot = { defaultProvider: 'jcode', providers: [
      { name: 'topics', status: 'ready', models: ['claude-opus-5'] },
      { name: 'jcode', status: 'ready', models: ['claude-opus-5'] },
    ] } as ProvidersSnapshot;
    const plan = await pickAutomaticTaskModel({ text: 'Task' }, undefined, {
      snapshot, codexModels: () => [],
      getProvider: () => ({ connected: true, complete: async () => ({ content: '{"provider":"topics","model":"claude-opus-5","effort":"high","weight":"light"}' }) }) as unknown as AIProvider,
    });
    expect(plan.provider).toBe('topics');
    expect(automaticTaskProvider(plan.provider!, plan.model, snapshot)).toBe('topics');
    expect(() => automaticTaskProvider('jcode', plan.model, snapshot)).toThrow('unavailable');
    snapshot.providers[0]!.status = 'loading';
    expect(() => automaticTaskProvider(plan.provider!, plan.model, snapshot)).toThrow('Waiting for topics');
  });
  const snapshot = { defaultProvider: 'topics', providers: [
    { name: 'topics', status: 'ready', models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'] },
    { name: 'codex', status: 'ready', models: models.map(m => m.slug) },
    { name: 'openai', status: 'ready', models: ['gpt-api-only'] },
    { name: 'gemini', status: 'ready', models: ['gemini-agent'] },
  ] } as ProvidersSnapshot;

  test('Auto can select either provider from one coding catalog, irrespective of the default', async () => {
    for (const chosen of ['claude-opus-5', 'gpt-5.6-sol']) {
      const plan = await pickAutomaticTaskModel({ text: 'A demanding task' }, undefined, {
        snapshot, codexModels: () => models,
        getProvider: () => ({ connected: true, complete: async (_messages: unknown, options: CompletionOptions) => {
          expect(options.model).toBe('claude-haiku-4-5');
          return { content: JSON.stringify({ model: chosen, effort: 'high', weight: 'light' }) };
        } }) as unknown as AIProvider,
      });
      expect(plan.model).toBe(chosen);
    }
    const catalog = automaticTaskCatalog(snapshot, models);
    expect(catalog.some(m => m.provider === 'topics')).toBe(true);
    expect(catalog.some(m => m.provider === 'codex')).toBe(true);
    expect(catalog.some(m => m.provider === 'openai' || m.provider === 'gemini')).toBe(false);
  });

  test('a Claude hold removes Claude execution candidates and its classifier', async () => {
    const accessed: string[] = [];
    const plan = await pickAutomaticTaskModel({ text: 'Task' }, undefined, {
      snapshot, claudeHeld: true, codexModels: () => models,
      getProvider: name => {
        accessed.push(name);
        return { connected: true, complete: async (messages: Array<{ content: string }>) => {
          expect(messages[0]?.content).not.toContain('claude-opus-5');
          return { content: '{"model":"gpt-5.6-sol","effort":"low","weight":"light"}' };
        } } as unknown as AIProvider;
      },
    });
    expect(plan.model).toBe('gpt-5.6-sol');
    expect(accessed).toEqual(['codex']);
  });

  test('fixed effort filters execution candidates while retaining a cheap classifier', async () => {
    const plan = await pickCodingTaskPlan({ text: 'Task' }, {
      models: models.map(m => ({ ...m, provider: 'codex' })), requiredEffort: 'max',
      complete: async (prompt, options) => {
        expect(options.model).toBe('gpt-5.6-luna');
        expect(prompt).not.toContain('"model":"gpt-5.6-sol"');
        expect(prompt).toContain('fixed effort to max');
        return '{"model":"gpt-6-astra","effort":"max","weight":"light"}';
      },
    });
    expect(plan).toMatchObject({ model: 'gpt-6-astra', effort: 'max', weight: 'light' });
    await expect(pickCodingTaskPlan({ text: 'Task' }, {
      models: [{ ...models[2]!, provider: 'codex' }], requiredEffort: 'max', complete: async () => 'must not run',
    })).rejects.toThrow('compatible effort');
  });
});
