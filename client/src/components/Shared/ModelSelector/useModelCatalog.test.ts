/**
 * The selector's catalog on the snapshot measured on 2026-10-02: Claude Code's
 * 11 ids, Codex's 8 with the windows and metadata of its cache (tasks 1.8).
 *
 * @covers MSEL-02, MSEL-03, MSEL-04, MSEL-05, MSEL-10
 */
import { describe, expect, test } from 'bun:test';
import {
  buildModelCatalog, filterModelCatalog, modelCommandSuggestions, rowEngine, rowSelected, taskMenuSelection,
  type CatalogSection,
} from './useModelCatalog';
import { contextWindowFor } from '../../../../../shared/context-window';
import { CLAUDE_CODE, CODEX_ENTRY, MEASURED, entry, snapshotOf } from './fixtures';

const label = (maker: string) => ({ anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', other: 'Altri' })[maker] ?? maker;
const section = (sections: CatalogSection[], maker: string) => sections.find((s) => s.maker === maker)!;
const AUTO = { provider: null, model: null };

describe('useModelCatalog: one row per model, divided by company', () => {
  const sections = buildModelCatalog(MEASURED, 'chat', AUTO);

  test('Anthropic and OpenAI each show 4 current rows; «Altri modelli» holds 3 and 4', () => {
    expect(section(sections, 'anthropic').rows.map((r) => r.label)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'Fable 5.1']);
    expect(section(sections, 'openai').rows.map((r) => r.label)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna']);
    expect(section(sections, 'anthropic').older.map((r) => r.label)).toEqual(['Opus 4.8', 'Sonnet 4.6', 'Haiku 3.5']);
    expect(section(sections, 'openai').older.map((r) => r.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  });

  test('the [1m] pairs become one row with the long id as a toggle', () => {
    const opus = section(sections, 'anthropic').rows[0]!;
    expect(opus).toMatchObject({ model: 'claude-opus-5-5', longModel: 'claude-opus-5-5[1m]' });
    const all = [...section(sections, 'anthropic').rows, ...section(sections, 'anthropic').older];
    expect(all).toHaveLength(7);
    expect(all.some((r) => r.model.endsWith('[1m]'))).toBe(false);
  });

  test('gpt-5.5 carries its retirement, and the GPT windows are the declared 272000', () => {
    const gpt55 = section(sections, 'openai').older.find((r) => r.model === 'gpt-5.5')!;
    expect(gpt55.retiresAt).toBe('2026-10-14T19:00:00Z');
    for (const row of [...section(sections, 'openai').rows, ...section(sections, 'openai').older]) {
      expect(contextWindowFor(row.model, row.windows[row.model]).tokens).toBe(272000);
    }
  });

  test('a model offered by two engines is one row with two engines, and the row engine follows one rule (MSEL-05)', () => {
    const fleet = snapshotOf([CLAUDE_CODE, entry('jcode', 'jcode', ['claude-sonnet-5-5']), CODEX_ENTRY]);
    const sonnet = section(buildModelCatalog(fleet, 'chat', AUTO), 'anthropic').rows.filter((r) => r.label === 'Sonnet 5.5');
    expect(sonnet).toHaveLength(1);
    expect(sonnet[0]!.engines.map((e) => e.name)).toEqual(['claude-code', 'jcode']);
    // 1. the engine already saved; 2. the snapshot default; 3. the preference order.
    expect(rowEngine(sonnet[0]!, { provider: 'jcode', model: 'claude-sonnet-5-5' }, 'claude-code')?.name).toBe('jcode');
    expect(rowEngine(sonnet[0]!, AUTO, 'jcode')?.name).toBe('jcode');
    expect(rowEngine(sonnet[0]!, AUTO, 'codex')?.name).toBe('claude-code');
  });

  test('the choice does not jump: a chat saved on jcode stays on jcode when the default changes', () => {
    const fleet = snapshotOf([CLAUDE_CODE, entry('jcode', 'jcode', ['claude-sonnet-5-5'])], 'claude-code');
    const value = { provider: 'jcode', model: 'claude-sonnet-5-5' };
    const row = section(buildModelCatalog(fleet, 'chat', value), 'anthropic').rows.find((r) => r.label === 'Sonnet 5.5')!;
    expect(rowSelected(row, value)).toBe(true);
    expect(rowEngine(row, value, fleet.defaultProvider)?.name).toBe('jcode');
  });

  test('the engine itself is never a row engine (AICTRL-01)', () => {
    for (const s of sections) for (const row of [...s.rows, ...s.older]) {
      expect(row.engines.some((e) => e.name === 'topics')).toBe(false);
    }
  });

  test('the cards keep only coding engines and offer «Automatico in Codex»', () => {
    const fleet = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, entry('openai', 'OpenAI', ['gpt-api-only'], { capabilities: ['streaming'] })]);
    const task = buildModelCatalog(fleet, 'task', AUTO);
    expect(section(task, 'openai').rows.some((r) => r.model === 'gpt-api-only')).toBe(false);
    expect(section(task, 'openai').automatic.map((e) => e.name)).toEqual(['codex']);
    const chat = buildModelCatalog(fleet, 'chat', AUTO);
    expect(section(chat, 'openai').rows.some((r) => r.model === 'gpt-api-only')).toBe(true);
  });

  test('a provider that is not ready is said with its reason; a stored value nobody offers stays selected and disabled', () => {
    const fleet = snapshotOf([CLAUDE_CODE, entry('codex', 'Codex', [], { status: 'unavailable', lastError: 'Sign in required' })]);
    const value = { provider: 'codex', model: 'gpt-5.5' };
    const sections = buildModelCatalog(fleet, 'chat', value);
    expect(sections[0]!.maker).toBe('openai');
    expect(section(sections, 'openai').notReady.map((e) => [e.name, e.reason])).toEqual([['codex', 'Sign in required']]);
    const stale = section(sections, 'openai').rows[0]!;
    expect(stale).toMatchObject({ stale: true, model: 'gpt-5.5' });
    expect(rowSelected(stale, value)).toBe(true);
  });
});

describe('MSEL-03: the search', () => {
  const sections = buildModelCatalog(MEASURED, 'chat', AUTO);
  test('«openai» leaves only OpenAI, folded rows included', () => {
    const found = filterModelCatalog(sections, 'openai', label);
    expect(found.map((s) => s.maker)).toEqual(['openai']);
    expect(found[0]!.rows).toHaveLength(8);
  });
  test('«gpt» leaves only OpenAI; case and accents do not matter; several words must all match', () => {
    expect(filterModelCatalog(sections, 'GPT', label).map((s) => s.maker)).toEqual(['openai']);
    expect(filterModelCatalog(sections, 'ópus', label).flatMap((s) => s.rows.map((r) => r.label))).toEqual(['Opus 5.5', 'Opus 4.8']);
    expect(filterModelCatalog(sections, 'opus 4', label).flatMap((s) => s.rows.map((r) => r.label))).toEqual(['Opus 4.8']);
    expect(filterModelCatalog(sections, 'zzz', label)).toEqual([]);
  });
});

describe('the stored task value, as the selector reads it', () => {
  test('provider:model, a bare legacy model and the legacy topics: prefix', () => {
    expect(taskMenuSelection('codex:gpt-6.1-sol', MEASURED)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    expect(taskMenuSelection('claude-opus-5-5', MEASURED)).toEqual({ provider: 'claude-code', model: 'claude-opus-5-5' });
    expect(taskMenuSelection('topics:claude-opus-5-5', MEASURED)).toEqual({ provider: 'claude-code', model: 'claude-opus-5-5' });
    expect(taskMenuSelection(null, MEASURED)).toEqual({ provider: null, model: null });
  });
});

describe('MSEL-10: /model completes with the current engine only', () => {
  test('«op» on Claude Code proposes the Opus models of Claude Code and nothing of Codex', () => {
    const found = modelCommandSuggestions(MEASURED, 'claude-code', 'op');
    expect(found.map((m) => m.label)).toEqual(['Opus 5.5', 'Opus 5.5 · 1M', 'Opus 4.8', 'Opus 4.8 · 1M']);
    expect(found.some((m) => m.id.startsWith('gpt-'))).toBe(false);
    expect(modelCommandSuggestions(MEASURED, 'codex', 'sol').map((m) => m.label)).toEqual(['GPT-6.1-Sol', 'GPT-6-Sol', 'GPT-5.6-Sol']);
  });
});
