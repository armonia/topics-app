/** @covers MSEL-02 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bareModelId, engineMaker, modelMaker } from './modelMaker';

// The 134 ids jcode listed on 2026-10-03 (revision 2026-10-04, §3.2).
const JCODE_IDS = readFileSync(join(import.meta.dir, '../tests/e2e/fixtures/jcode-models.txt'), 'utf8')
  .split('\n').map((line) => line.trim()).filter(Boolean);
const JCODE = { name: 'jcode', label: 'jcode' };

describe('modelMaker: the company that makes a model, never a catch-all (revision §3.2, AC-02)', () => {
  test.each([
    ['gpt-oss:20b', 'openai'],
    ['codex:gpt-6-sol', 'openai'],
    ['qwen3-coder:30b', 'qwen'],
    ['anthropic/claude-sonnet-4.5', 'anthropic'],
    ['x-ai/grok-4', 'xai'],
    ['nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia'],
    ['google/gemma-3-4b-it', 'google'],
    ['zai-glm-4.7', 'zai'],
    // The ids of today's catalogs keep their company.
    ['claude-opus-5-5', 'anthropic'],
    ['claude-sonnet-5-5[1m]', 'anthropic'],
    ['claude-code:claude-fable-5-1', 'anthropic'],
    ['gpt-6.1-sol', 'openai'],
    ['o3', 'openai'],
    ['gemini-3-pro', 'google'],
    ['gemma3:27b', 'google'],
    ['llama3.3:70b', 'meta'],
    ['meta-llama/llama-4-maverick', 'meta'],
    ['deepseek-r1:32b', 'deepseek'],
    ['mistralai/devstral-medium', 'mistral'],
  ] as const)('%s → %s', (id, maker) => {
    expect(modelMaker(id, JCODE).id).toBe(maker);
  });

  test('an id with no known company is named by the provider that offers it', () => {
    expect(modelMaker('openclaw', { name: 'openclaw', label: 'OpenClaw' })).toEqual({ id: 'provider:openclaw', label: 'OpenClaw' });
  });

  test('an unknown vendor/ prefix is a company of its own, not a fallback', () => {
    expect(modelMaker('databricks/dbrx-instruct', JCODE)).toEqual({ id: 'vendor:databricks', label: 'Databricks' });
  });

  test('the companies read as names: Meta, xAI, Z.ai, NVIDIA', () => {
    expect(modelMaker('meta/llama2-70b', JCODE).label).toBe('Meta');
    expect(modelMaker('x-ai/grok-4', JCODE).label).toBe('xAI');
    expect(modelMaker('z-ai/glm-5.3', JCODE).label).toBe('Z.ai');
    expect(modelMaker('nvidia', JCODE).label).toBe('NVIDIA');
  });

  test('on the 134 real jcode ids: 20 companies and 0 fallbacks', () => {
    expect(JCODE_IDS).toHaveLength(134);
    const makers = new Set(JCODE_IDS.map((id) => modelMaker(id, JCODE).id));
    expect(makers.size).toBe(20);
    expect([...makers].filter((maker) => maker.startsWith('provider:'))).toEqual([]);
  });
});

describe('engineMaker: the company of a provider that lists no model', () => {
  test('the static table: subscriptions and APIs', () => {
    expect(engineMaker('claude-code')).toBe('anthropic');
    expect(engineMaker('claude')).toBe('anthropic');
    expect(engineMaker('codex')).toBe('openai');
    expect(engineMaker('openai')).toBe('openai');
    expect(engineMaker('gemini')).toBe('google');
    expect(engineMaker('muse')).toBe('meta');
  });
  test('a muse-prefixed value peels to the bare slug', () => {
    expect(bareModelId('muse:muse-spark-1.3-contributor')).toBe('muse-spark-1.3-contributor');
  });
  test('an agent or an endpoint has none: it serves many companies', () => {
    expect(engineMaker('jcode')).toBeNull();
    expect(engineMaker('direct-lmstudio')).toBeNull();
    expect(engineMaker('goose')).toBeNull();
  });
});
