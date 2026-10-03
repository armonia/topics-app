/** @covers AGPT-01 AGPT-02 CODEX-MODEL-01 MSEL-04 MSEL-09 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readCodexModels, codexFallbackModel, readCodexConfiguredModel, codexContextWindows, codexModelInfo } from './models';

test('account catalog only returns visible unique IDs with advertised metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-catalog-test-'));
  try {
    const path = join(dir, 'models_cache.json');
    writeFileSync(path, JSON.stringify({ models: [
      { slug: 'gpt-available', visibility: 'list', description: 'Affordable', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, null, { effort: 'high' }] },
      { slug: 'gpt-hidden', visibility: 'hide' }, { slug: 'gpt-available', visibility: 'list' }, null,
    ] }));
    expect(readCodexModels(path)).toEqual([{ slug: 'gpt-available', description: 'Affordable', defaultEffort: 'low', efforts: ['low', 'high'] }]);
    writeFileSync(path, 'broken');
    expect(readCodexModels(path)).toEqual([]);
    expect(readCodexModels(join(dir, 'absent'))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a configured default missing from the catalog falls back to a listed model', () => {
  // 23/09: config.toml said gpt-6-sol, the account lists gpt-6-astra first,
  // and every turn without an explicit model died with a 400.
  expect(codexFallbackModel('gpt-6-sol', ['gpt-6-astra', 'gpt-5.5'])).toBe('gpt-6-astra');
  expect(codexFallbackModel('gpt-5.5', ['gpt-6-astra', 'gpt-5.5'])).toBeNull();
  expect(codexFallbackModel('gpt-6-sol', [])).toBeNull();
  expect(codexFallbackModel(null, ['gpt-5.5'])).toBeNull();
});

test('the configured model is read from the top level of config.toml only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-config-test-'));
  try {
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'personality = "x"\nmodel = "gpt-6-sol"\n\n[profiles.fast]\nmodel = "gpt-5.5"\n');
    expect(readCodexConfiguredModel(path)).toBe('gpt-6-sol');
    writeFileSync(path, '[profiles.fast]\nmodel = "gpt-5.5"\n');
    expect(readCodexConfiguredModel(path)).toBeNull();
    expect(readCodexConfiguredModel(join(dir, 'absent'))).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a TOML literal string (single quotes) is read too', () => {
  // Valid TOML written by hand: missed, the out-of-catalog guard was skipped
  // and the turn died on the 400 "model is not supported".
  const dir = mkdtempSync(join(tmpdir(), 'codex-config-test-'));
  try {
    const path = join(dir, 'config.toml');
    writeFileSync(path, "model = 'gpt-6-sol'\n");
    expect(readCodexConfiguredModel(path)).toBe('gpt-6-sol');
    writeFileSync(path, "  model='gpt-6-sol' # hand-edited\n");
    expect(readCodexConfiguredModel(path)).toBe('gpt-6-sol');
    writeFileSync(path, "model_provider = 'x'\n");
    expect(readCodexConfiguredModel(path)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The cache measured on 2026-10-02, the fields that matter here: 8 visible
 *  models, one hidden, 272000 everywhere, and GPT-5.5 retiring on 14/10. */
const MEASURED_CACHE = { models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', priority: 1, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Latest workhorse model for coding and everyday work.' },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', priority: 2, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Frontier intelligence for the most demanding work.' },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', priority: 3, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Previous generation workhorse model.' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', priority: 4, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Fast and affordable model for easier tasks.' },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', priority: 4, visibility: 'hide', context_window: 272000 },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', priority: 5, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Older generation workhorse model.' },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', priority: 8, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Older balanced model for straightforward work.' },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', priority: 9, visibility: 'list', context_window: 272000, max_context_window: 872000, description: 'Older fast and efficient model.' },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 13, visibility: 'list', context_window: 272000, max_context_window: 272000, description: 'Legacy coding model.', upgrade: { model: 'gpt-6.1-sol', retirement_at: '2026-10-14T19:00:00Z' } },
] };

test('MSEL-09: the snapshot carries description, retirement, label and generation from the Codex cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-catalog-info-'));
  try {
    const path = join(dir, 'models_cache.json');
    writeFileSync(path, JSON.stringify(MEASURED_CACHE));
    const models = readCodexModels(path);
    expect(models.map((m) => m.slug)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
    const info = codexModelInfo(models);
    expect(info['gpt-5.5']).toEqual({ label: 'GPT-5.5', description: 'Legacy coding model.', retiresAt: '2026-10-14T19:00:00Z', replacement: 'gpt-6.1-sol', generation: 'older' });
    expect(info['gpt-6.1-sol']).toMatchObject({ label: 'GPT-6.1-Sol', generation: 'current' });
    expect(Object.entries(info).filter(([, v]) => v.generation === 'current').map(([k]) => k)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
    expect(Object.entries(info).filter(([, v]) => v.generation === 'older').map(([k]) => k)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MSEL-04: Codex declares context_window (272000), never max_context_window (872000)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-catalog-window-'));
  try {
    const path = join(dir, 'models_cache.json');
    writeFileSync(path, JSON.stringify(MEASURED_CACHE));
    const windows = codexContextWindows(readCodexModels(path));
    expect(windows['gpt-6.1-sol']).toBe(272000);
    expect(Object.values(windows).every((w) => w === 272000)).toBe(true);
    expect(Object.keys(windows)).toHaveLength(8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
