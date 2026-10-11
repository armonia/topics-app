/**
 * The selector's catalog on the snapshot measured on 2026-10-02 (Claude Code's
 * 11 ids, Codex's 8) and on the audit fleet of revision 2026-10-04.
 *
 * @covers MSEL-02, MSEL-03, MSEL-04, MSEL-05, MSEL-10
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildModelCatalog, catalogColumns, connectAction, filterModelCatalog, rowSelected, signInCommand, taskMenuSelection,
  type CatalogGroup,
} from './useModelCatalog';
import { contextWindowFor } from '../../../../../shared/context-window';
import { modelCommandSuggestions } from './modelCommand';
import { providersCountTail } from '../../Sidebar/formLevelTails';
import { t } from '../../../lib/i18n';
import { AUDIT_KEYS, AUDIT_NO_KEYS, CLAUDE_CODE, CODEX_ENTRY, ENGINE, MEASURED, entry, snapshotOf } from './fixtures';

const group = (groups: CatalogGroup[], maker: string) => groups.find((g) => g.maker === maker)!;
const labels = (rows: { label: string }[]) => rows.map((r) => r.label);
const AUTO = { provider: null, model: null };

describe('one row per model, grouped by company (MSEL-02)', () => {
  const groups = buildModelCatalog(MEASURED, 'chat', AUTO);

  test('Anthropic and OpenAI each show 4 current rows, the older ones fold', () => {
    expect(labels(group(groups, 'anthropic').rows)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'Fable 5.1']);
    expect(labels(group(groups, 'openai').rows)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna']);
    expect(labels(group(groups, 'anthropic').older)).toEqual(['Opus 4.8', 'Sonnet 4.6', 'Haiku 3.5']);
    expect(group(groups, 'openai').older.map((r) => r.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  });

  test('the [1m] pairs become one row with the long id as a switch', () => {
    const opus = group(groups, 'anthropic').rows[0]!;
    expect(opus).toMatchObject({ model: 'claude-opus-5-5', longModel: 'claude-opus-5-5[1m]' });
    const all = [...group(groups, 'anthropic').rows, ...group(groups, 'anthropic').older];
    expect(all).toHaveLength(7);
    expect(all.some((r) => r.model?.endsWith('[1m]'))).toBe(false);
  });

  test('gpt-5.5 carries its retirement, and the GPT windows are the declared 272000', () => {
    const retiring = group(groups, 'openai').older.find((r) => r.model === 'gpt-5.5')!;
    expect(retiring.retiresAt).toBe('2026-10-14T19:00:00Z');
    for (const row of [...group(groups, 'openai').rows, ...group(groups, 'openai').older]) {
      expect(contextWindowFor(row.model, row.windows[row.model!]).tokens).toBe(272000);
    }
  });

  test('the engine itself is never a row engine (AICTRL-01)', () => {
    for (const g of groups) for (const row of [...g.rows, ...g.older]) {
      expect(row.engines.some((e) => e.name === 'topics')).toBe(false);
    }
  });
});

describe('the audit fleet, with keys (revision §3.4-3.5, AC-04, AC-13, AC-14)', () => {
  const groups = buildModelCatalog(AUDIT_KEYS, 'chat', AUTO, { routing: true });

  test('every group is a company: no catch-all, goose (no company) makes none', () => {
    expect(groups.map((g) => g.maker).sort()).toEqual(['anthropic', 'deepseek', 'google', 'meta', 'mistral', 'openai', 'qwen', 'xai']);
  });

  test('columns: Anthropic, OpenAI, Google, then Meta, DeepSeek, Mistral, Qwen, xAI stacked', () => {
    expect(catalogColumns(groups).map((column) => column.map((g) => g.maker))).toEqual([
      ['anthropic'], ['openai'], ['google'], ['meta', 'deepseek', 'mistral', 'qwen', 'xai'],
    ]);
  });

  test('the order is fixed: a saved Google model does not move Google first (AC-05)', () => {
    const saved = buildModelCatalog(AUDIT_KEYS, 'chat', { provider: 'gemini', model: 'gemini-3-pro' }, { routing: true });
    expect(catalogColumns(saved).map((column) => column[0]!.maker)).toEqual(['anthropic', 'openai', 'google', 'meta']);
  });

  test('gemma3 is Google, gpt-oss is OpenAI', () => {
    expect([...group(groups, 'google').rows, ...group(groups, 'google').older].some((r) => r.ids['direct-ollama']?.model === 'gemma3:27b')).toBe(true);
    expect(group(groups, 'openai').rows.some((r) => r.ids['direct-ollama']?.model === 'gpt-oss:20b')).toBe(true);
  });

  test('OpenAI: 8 current rows and «Precedenti (6)», by the family rule where nobody declares', () => {
    expect(group(groups, 'openai').rows).toHaveLength(8);
    expect(group(groups, 'openai').older).toHaveLength(6);
    expect(group(groups, 'anthropic').rows).toHaveLength(4);
  });

  test('the heading names the engine of the group; ⌄ only from two engines (AC-14)', () => {
    const heading = (maker: string) => [group(groups, maker).who, group(groups, maker).engines.length > 1];
    expect(heading('anthropic')).toEqual(['Topics', true]);
    expect(heading('openai')).toEqual(['Codex', true]);
    expect(heading('google')).toEqual(['Gemini CLI', true]);
    expect(heading('meta')).toEqual(['Ollama (Mac mini)', true]);
    expect(heading('deepseek')).toEqual(['Ollama (Mac mini)', false]);
    expect(heading('mistral')).toEqual(['OpenRouter', false]);
    expect(group(groups, 'anthropic').engines.map((e) => e.name)).toEqual(['claude-code', 'claude', 'jcode', 'direct-openrouter']);
  });

  test('«via X» on a row only when who runs it differs from the heading (AC-13)', () => {
    const row = (maker: string, model: string) => [...group(groups, maker).rows, ...group(groups, maker).older].find((r) => r.model === model)!;
    expect(row('openai', 'o4-mini').via).toBe('OpenAI API');
    expect(row('anthropic', 'claude-opus-4-8').via).toBe('Claude Code');
    expect(row('anthropic', 'claude-opus-5-5').via).toBeNull();
    expect(row('anthropic', 'claude-opus-5-5').viaTopics).toBe(true);
    expect(row('openai', 'gpt-6.1-sol').via).toBeNull();
  });

  test('the footer count: 9 ready, 1 error (AC-22)', () => {
    expect(providersCountTail(AUDIT_KEYS, (key, vars) => t(key, 'it', vars))?.text).toBe('9 pronti · 1 errore');
  });

  test('a heading engine chosen in ⌄ runs the rows it serves (AC-15)', () => {
    const chosen = buildModelCatalog(AUDIT_KEYS, 'chat', AUTO, { routing: true, groupEngines: { openai: 'openai' } });
    const openAiGroup = group(chosen, 'openai');
    expect(openAiGroup.who).toBe('OpenAI API');
    expect(openAiGroup.rows.find((r) => r.ids.openai?.model === 'gpt-6.1-sol')!.engine?.name).toBe('openai');
    // A model that API does not list keeps its own engine, named on the row.
    expect(openAiGroup.rows.find((r) => r.ids.codex?.model === 'gpt-6-sol')!.via).toBe('Codex');
  });

});

describe('MSEL-05: the engine of a group follows one rule', () => {
  const fleet = snapshotOf([CLAUDE_CODE, entry('jcode', 'jcode', ['claude-sonnet-5-5']), CODEX_ENTRY]);

  test('a model offered by two engines is one row with two engines', () => {
    const sonnet = group(buildModelCatalog(fleet, 'chat', AUTO), 'anthropic').rows.filter((r) => r.label === 'Sonnet 5.5');
    expect(sonnet).toHaveLength(1);
    expect(sonnet[0]!.engines.map((e) => e.name)).toEqual(['claude-code', 'jcode']);
  });

  test('1. the saved engine; 2. the snapshot default; 3. the preference order', () => {
    const saved = { provider: 'jcode', model: 'claude-sonnet-5-5' };
    expect(group(buildModelCatalog(fleet, 'chat', saved), 'anthropic').engine?.name).toBe('jcode');
    expect(group(buildModelCatalog(snapshotOf(fleet.providers, 'jcode'), 'chat', AUTO), 'anthropic').engine?.name).toBe('jcode');
    expect(group(buildModelCatalog(snapshotOf(fleet.providers, 'codex'), 'chat', AUTO), 'anthropic').engine?.name).toBe('claude-code');
  });

  test('the choice does not jump: a chat saved on jcode stays on jcode when the default changes', () => {
    const value = { provider: 'jcode', model: 'claude-sonnet-5-5' };
    const row = group(buildModelCatalog(fleet, 'chat', value), 'anthropic').rows.find((r) => r.label === 'Sonnet 5.5')!;
    expect(rowSelected(row, value)).toBe(true);
    expect(row.engine?.name).toBe('jcode');
  });
});

describe('the merge key joins what two engines call differently (AC-03)', () => {
  test('gpt-oss:20b on Ollama and openai/gpt-oss-20b on jcode: one OpenAI row, two engines', () => {
    const fleet = snapshotOf([
      entry('jcode', 'jcode', ['openai/gpt-oss-20b']),
      entry('direct-ollama', 'Ollama', ['gpt-oss:20b'], { capabilities: ['streaming'] }),
    ]);
    const rows = group(buildModelCatalog(fleet, 'chat', AUTO), 'openai').rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('GPT-OSS 20B');
    expect(rows[0]!.engines.map((e) => e.name)).toEqual(['jcode', 'direct-ollama']);
    // Each engine keeps its own id: the saved value is the one that engine runs.
    expect(rows[0]!.ids).toEqual({ jcode: { model: 'openai/gpt-oss-20b', longModel: null }, 'direct-ollama': { model: 'gpt-oss:20b', longModel: null } });
    expect(rowSelected(rows[0]!, { provider: 'direct-ollama', model: 'gpt-oss:20b' })).toBe(true);
  });
});

describe('without ready accounts: the connect box (revision §4.6, AC-16, AC-17, AC-19)', () => {
  const groups = buildModelCatalog(AUDIT_NO_KEYS, 'chat', AUTO, { routing: true });

  test('OpenAI lists only Codex, Google only Gemini CLI; LM Studio makes no group', () => {
    expect(group(groups, 'openai').connect.map((e) => [e.name, e.action, e.status])).toEqual([['codex', 'signIn', 'unavailable']]);
    expect(group(groups, 'google').connect.map((e) => [e.name, e.action])).toEqual([['gemini', 'setUp']]);
    expect(group(groups, 'openai').rows).toEqual([]);
    expect(groups.map((g) => g.maker)).toEqual(['anthropic', 'openai', 'google']);
    expect(group(groups, 'openai').status).toBe('unavailable');
  });

  test('«Non mi serve» hides the box, and with no rows the group goes', () => {
    const hidden = buildModelCatalog(AUDIT_NO_KEYS, 'chat', AUTO, { hidden: ['codex'] });
    expect(hidden.map((g) => g.maker)).toEqual(['anthropic', 'google']);
  });

  test('a ready engine with no models has an Automatic row in its company (AC-16)', () => {
    const fleet = snapshotOf([CLAUDE_CODE, entry('gemini', 'Gemini CLI', []), ENGINE]);
    const google = group(buildModelCatalog(fleet, 'chat', AUTO), 'google');
    expect(google.rows).toHaveLength(1);
    expect(google.rows[0]).toMatchObject({ automatic: true, model: null });
    expect(google.rows[0]!.engine?.name).toBe('gemini');
    expect(rowSelected(google.rows[0]!, { provider: 'gemini', model: null })).toBe(true);
  });

  test('a stored value nobody offers stays selected and disabled', () => {
    const fleet = snapshotOf([CLAUDE_CODE, entry('codex', 'Codex', [], { status: 'unavailable' })]);
    const value = { provider: 'codex', model: 'gpt-5.5' };
    const openAiGroup = group(buildModelCatalog(fleet, 'chat', value), 'openai');
    expect(openAiGroup.rows[0]).toMatchObject({ stale: true, model: 'gpt-5.5' });
    expect(rowSelected(openAiGroup.rows[0]!, value)).toBe(true);
  });

  test('an unsigned muse offers sign-in with its login command', () => {
    expect(connectAction('muse')).toBe('signIn');
    expect(signInCommand('muse')).toBe('muse login');
    const fleet = snapshotOf([entry('muse', 'Muse', [], { status: 'unavailable' })]);
    expect(group(buildModelCatalog(fleet, 'chat', AUTO), 'meta').connect.map((e) => [e.name, e.action]))
      .toEqual([['muse', 'signIn']]);
  });
});

describe('cards (scope task)', () => {
  test('only coding engines, with «Automatico» within Codex', () => {
    const fleet = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, entry('openai', 'OpenAI', ['gpt-api-only'], { capabilities: ['streaming'] })]);
    const task = buildModelCatalog(fleet, 'task', AUTO);
    expect(group(task, 'openai').rows.some((r) => r.model === 'gpt-api-only')).toBe(false);
    expect(group(task, 'openai').rows.filter((r) => r.automatic).map((r) => r.engine?.name)).toEqual(['codex']);
    const chat = buildModelCatalog(fleet, 'chat', AUTO);
    expect(group(chat, 'openai').rows.some((r) => r.model === 'gpt-api-only')).toBe(true);
  });
});

describe('the 134 real jcode ids (AC-02 in the catalog)', () => {
  const ids = readFileSync(join(import.meta.dir, '../../../../../tests/e2e/fixtures/jcode-models.txt'), 'utf8').split('\n').filter(Boolean);
  const groups = buildModelCatalog(snapshotOf([entry('jcode', 'jcode', ids)]), 'chat', AUTO);

  test('20 companies, none a fallback, and four columns at most', () => {
    expect(groups).toHaveLength(20);
    expect(groups.some((g) => g.maker.startsWith('provider:'))).toBe(false);
    const columns = catalogColumns(groups);
    expect(columns).toHaveLength(4);
    expect(columns[3]).toHaveLength(17);
  });

  // The revision measured OpenAI 16/18 and Anthropic 4/11 before merging: the
  // merge key joins the dated ids (claude-haiku-4-5-20251001 = claude-haiku-4-5),
  // so on 31 OpenAI ids the split is 16/15.
  test('the family rule folds the old generations: OpenAI 16/15, Google 22/8, Anthropic 4/10', () => {
    const split = (maker: string) => [group(groups, maker).rows.length, group(groups, maker).older.length];
    expect([split('openai'), split('google'), split('anthropic')]).toEqual([[16, 15], [22, 8], [4, 10]]);
  });
});

describe('the search', () => {
  const groups = buildModelCatalog(MEASURED, 'chat', AUTO);
  test('«openai» leaves only OpenAI, folded rows included', () => {
    const found = filterModelCatalog(groups, 'openai', 'Automatico');
    expect(found.map((g) => g.maker)).toEqual(['openai']);
    expect(found[0]!.rows).toHaveLength(8);
  });
  test('case and accents do not matter; several words must all match', () => {
    expect(filterModelCatalog(groups, 'GPT', 'Automatico').map((g) => g.maker)).toEqual(['openai']);
    expect(filterModelCatalog(groups, 'ópus', 'Automatico').flatMap((g) => labels(g.rows))).toEqual(['Opus 5.5', 'Opus 4.8']);
    expect(filterModelCatalog(groups, 'opus 4', 'Automatico').flatMap((g) => labels(g.rows))).toEqual(['Opus 4.8']);
    expect(filterModelCatalog(groups, 'zzz', 'Automatico')).toEqual([]);
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

describe('/model completes with the current engine only', () => {
  test('«op» on Claude Code proposes the Opus models of Claude Code and nothing of Codex', () => {
    const found = modelCommandSuggestions(MEASURED, 'claude-code', 'op');
    expect(found.map((m) => m.label)).toEqual(['Opus 5.5', 'Opus 5.5 · 1M', 'Opus 4.8', 'Opus 4.8 · 1M']);
    expect(found.some((m) => m.id.startsWith('gpt-'))).toBe(false);
    expect(modelCommandSuggestions(MEASURED, 'codex', 'sol').map((m) => m.label)).toEqual(['GPT-6.1-Sol', 'GPT-6-Sol', 'GPT-5.6-Sol']);
  });
});
