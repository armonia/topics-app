/**
 * The mode separated from the model name.
 *
 * These tests protect `splitModelId` itself, not the label it feeds into:
 * it must only peel a trailing `[1m]`, and leave every other id — Claude,
 * Codex, OpenAI — untouched. What happens to the peeled name downstream
 * (`friendlyModelLabel`) is a separate concern with its own coverage.
 *
 * @covers CHAT-DEF-03, MSEL-04, MSEL-09
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { friendlyModelLabel, modelDisplayLabel, modelTriggerText, splitModelId, triggerLine } from './modelLabel';
import { t } from './i18n';

describe('splitModelId', () => {
  test('un id senza modalità torna identico', () => {
    expect(splitModelId('claude-opus-5')).toEqual({ name: 'claude-opus-5', longContext: false });
  });

  test('stacca il suffisso [1m] dal nome', () => {
    expect(splitModelId('claude-opus-5[1m]')).toEqual({ name: 'claude-opus-5', longContext: true });
  });

  test('accetta il suffisso anche maiuscolo', () => {
    expect(splitModelId('claude-opus-5[1M]')).toEqual({ name: 'claude-opus-5', longContext: true });
  });

  test('NON tocca gli id degli altri provider', () => {
    // splitModelId only peels the mode suffix — it must return non-Claude
    // ids byte-for-byte, whatever `friendlyModelLabel` later does with them.
    expect(splitModelId('gpt-5.4-mini')).toEqual({ name: 'gpt-5.4-mini', longContext: false });
    expect(splitModelId('o3')).toEqual({ name: 'o3', longContext: false });
  });

  test('il suffisso conta solo in CODA', () => {
    // Un `[1m]` in mezzo non è la modalità: toglierlo cambierebbe l'id.
    expect(splitModelId('foo[1m]-bar')).toEqual({ name: 'foo[1m]-bar', longContext: false });
  });

  test('una stringa vuota non esplode', () => {
    expect(splitModelId('')).toEqual({ name: '', longContext: false });
  });
});

describe('friendlyModelLabel', () => {
  test('keeps the explicit execution engine visible', () => {
    expect(friendlyModelLabel('topics:claude-opus-5')).toBe('Opus 5 · Topics');
    expect(friendlyModelLabel('codex:gpt-5.6-sol')).toBe('GPT-5.6-sol · Codex');
    expect(friendlyModelLabel('claude-code:auto')).toBe('Automatic · Claude Code');
  });

  test('a dated snapshot id drops the date instead of gluing it to the version', () => {
    // `claude-haiku-4-5-20251001` is in the native provider's MODELS list.
    expect(friendlyModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(friendlyModelLabel('claude-haiku-4-5-20251001[1m]')).toBe('Haiku 4.5 · 1M');
  });
});

// Revision 2026-10-04 §3.6: one label rule for every company, measured on the
// 134 ids jcode listed (tests/e2e/fixtures/jcode-models.txt).
describe('modelDisplayLabel (revision §3.6, AC-11)', () => {
  const ids = readFileSync(join(import.meta.dir, '../../../tests/e2e/fixtures/jcode-models.txt'), 'utf8')
    .split('\n').map((line) => line.trim()).filter(Boolean);

  test.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['anthropic/claude-sonnet-4.5', 'Sonnet 4.5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
    ['gpt-oss:20b', 'GPT-OSS 20B'],
    ['openai/gpt-oss-20b', 'GPT-OSS 20B'],
    ['o4-mini', 'o4-mini'],
    ['gpt-4.1', 'GPT-4.1'],
    ['zai-glm-4.7', 'GLM 4.7'],
    ['qwen3-coder:30b', 'Qwen3 Coder 30B'],
    ['gemma3:27b', 'Gemma3 27B'],
    ['deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek v4 Flash'],
    ['gemini-2.5-computer-use-preview-10-2025', 'Gemini 2.5 Computer Use Preview'],
    ['gpt-5.6-pro[web]', 'GPT-5.6 Pro (web)'],
    ['mistralai/mixtral-8x22b-v0.1', 'Mixtral 8x22B v0.1'],
    ['microsoft/phi-3.5-moe-instruct', 'Phi 3.5 MOE Instruct'],
  ] as const)('%s → %s', (id, label) => {
    expect(modelDisplayLabel(id)).toBe(label);
  });

  test('a catalog label wins', () => {
    expect(modelDisplayLabel('gpt-6.1-sol', { label: 'GPT-6.1-Sol' })).toBe('GPT-6.1-Sol');
  });

  test('no real id keeps a date or a raw vendor prefix in its label', () => {
    for (const id of ids) {
      const label = modelDisplayLabel(id);
      expect(label, id).not.toMatch(/\d{8}|\b(0[1-9]|1[0-2])-20\d\d\b|\//);
      expect(label.length, id).toBeGreaterThan(0);
    }
  });
});

describe('modelTriggerText: one closed format, «label · who» (revision §3.8, AC-30, AC-31)', () => {
  const snapshot = {
    defaultProvider: 'claude-code',
    providers: [
      { name: 'claude-code', label: 'Claude Code' },
      { name: 'codex', label: 'Codex', modelInfo: { 'gpt-6.1-sol': { label: 'GPT-6.1-Sol' } } },
    ],
  };
  const tr = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
  const line = (value: { provider: string | null; model: string | null }, surface: 'chat' | 'task' | 'board' | 'provider', viaTopics = false, automaticWho?: string) =>
    triggerLine(modelTriggerText(value, { snapshot, tr, surface, viaTopics, automaticWho }));

  test('the table of §3.8', () => {
    expect(line({ provider: 'claude-code', model: 'claude-opus-5-5' }, 'chat', true)).toBe('Opus 5.5 · via Topics');
    expect(line({ provider: 'codex', model: 'gpt-6.1-sol' }, 'chat')).toBe('GPT-6.1-Sol · via Codex');
    expect(line({ provider: null, model: null }, 'chat', false, 'Claude Code')).toBe('Automatico · Claude Code');
    expect(line({ provider: null, model: null }, 'task')).toBe('Automatico · segue la board');
    expect(line({ provider: null, model: null }, 'board')).toBe('Automatico · Topics sceglie');
    expect(line({ provider: null, model: null }, 'provider')).toBe('Automatico');
  });

  test('no context window and no [1m] in the closed text', () => {
    expect(line({ provider: 'claude-code', model: 'claude-opus-5-5[1m]' }, 'chat')).toBe('Opus 5.5 · via Claude Code');
  });

  test('Automatic within one engine names the engine', () => {
    expect(line({ provider: 'codex', model: null }, 'task')).toBe('Automatico · Codex');
  });
});
