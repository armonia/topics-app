/** @covers AGPT-01 AGPT-02 CODEX-MODEL-01 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readCodexModels, codexFallbackModel, readCodexConfiguredModel } from './models';

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
