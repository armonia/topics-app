/** @covers AGPT-01 AGPT-02 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readCodexModels } from './models';

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
