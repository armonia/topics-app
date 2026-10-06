/** @covers MUSE-04 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readMuseModels, readMuseConfiguredModel, museDefaultModel,
  museContextWindows, museModelInfo, MUSE_STATIC_FALLBACK_MODEL,
} from './models';

/** The cache measured on 2026-10-06, the fields that matter here. */
const MEASURED_ROWS = [
  { model_id: 'muse-spark-1.3', display_label: 'muse-spark-1.3', visibility: 'visible', is_current: false, is_default: false, context_limit: 1007997, output_limit: 128000, description: null, reasoning_effort_variants: [{ tier: 'low' }, null, { tier: 'high' }] },
  { model_id: 'muse-spark-1.3-contributor', display_label: 'muse-spark-1.3-contributor', visibility: 'visible', is_current: true, is_default: true, context_limit: 1007997, output_limit: 128000, description: 'Your content may be used for product improvement.', reasoning_effort_variants: [{ tier: 'minimal' }, { tier: 'max' }] },
  { model_id: 'muse-spark-1.2', display_label: 'muse-spark-1.2', visibility: 'visible', is_current: false, is_default: false, context_limit: 1007997, output_limit: 128000, description: null, reasoning_effort_variants: null },
  { model_id: 'muse-spark-1.2-contributor', display_label: 'muse-spark-1.2-contributor', visibility: 'visible', is_current: false, is_default: false, context_limit: 1007997, output_limit: 128000, description: null, reasoning_effort_variants: [] },
  { model_id: 'muse-image-1.0', display_label: 'Muse Image', visibility: 'hidden', context_limit: null, output_limit: null, description: null, reasoning_effort_variants: null },
];

function catalogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muse-catalog-test-'));
  writeFileSync(join(dir, '6d657461__p746268.json'), JSON.stringify({ schema_version: 2, provider_id: 'meta', rows: MEASURED_ROWS }));
  return dir;
}

test('the catalog returns visible unique ids with their metadata', () => {
  const dir = catalogDir();
  try {
    const models = readMuseModels(dir);
    expect(models.map((m) => m.slug)).toEqual([
      'muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-spark-1.2', 'muse-spark-1.2-contributor',
    ]);
    expect(models[0]).toMatchObject({ contextWindow: 1007997, efforts: ['low', 'high'] });
    expect(models[0]?.label).toBeUndefined();
    expect(models[1]).toMatchObject({ isDefault: true, efforts: ['minimal', 'max'] });
    expect(models[2]?.efforts).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('broken files and missing dirs read as an empty catalog, never throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-catalog-test-'));
  try {
    writeFileSync(join(dir, 'bad.json'), 'broken');
    writeFileSync(join(dir, 'norows.json'), JSON.stringify({ rows: null }));
    expect(readMuseModels(dir)).toEqual([]);
    expect(readMuseModels(join(dir, 'absent'))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the configured model is the `model` of settings.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-settings-test-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ schema_version: 1, provider: 'meta', model: 'muse-spark-1.3' }));
    expect(readMuseConfiguredModel(path)).toBe('muse-spark-1.3');
    writeFileSync(path, JSON.stringify({ provider: 'meta' }));
    expect(readMuseConfiguredModel(path)).toBeNull();
    expect(readMuseConfiguredModel(join(dir, 'absent'))).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the picker default is configured-when-listed, else the catalog default, else the static fallback', () => {
  const dir = catalogDir();
  try {
    const models = readMuseModels(dir);
    expect(museDefaultModel('muse-spark-1.3', models)).toBe('muse-spark-1.3');
    expect(museDefaultModel('muse-spark-9', models)).toBe('muse-spark-1.3-contributor');
    expect(museDefaultModel(null, models)).toBe('muse-spark-1.3-contributor');
    expect(museDefaultModel('muse-spark-1.3', [])).toBe('muse-spark-1.3');
    expect(museDefaultModel(null, [])).toBe(MUSE_STATIC_FALLBACK_MODEL);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the snapshot carries windows, labels and generation from the cache', () => {
  const dir = catalogDir();
  try {
    const models = readMuseModels(dir);
    const windows = museContextWindows(models);
    expect(windows['muse-spark-1.3']).toBe(1007997);
    expect(Object.keys(windows)).toHaveLength(4);
    const info = museModelInfo(models);
    expect(info['muse-spark-1.3-contributor']).toMatchObject({ generation: 'current' });
    expect(info['muse-spark-1.3-contributor']?.description).toContain('product improvement');
    expect(info['muse-spark-1.2']?.generation).toBe('older');
    expect(info['muse-spark-1.2-contributor']?.generation).toBe('older');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
