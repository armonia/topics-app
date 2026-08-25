/**
 * @covers KANBAN-43
 */
import { describe, test, expect } from 'bun:test';
import { buildFileRows, splitPatch } from './diffFileRows';
import type { DiffFileStat } from '../../lib/board';

function stat(path: string, additions = 1, deletions = 0, status = 'M'): DiffFileStat {
  return { path, additions, deletions, status };
}

function chunkFor(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-vecchio\n+nuovo\n`;
}

describe('buildFileRows', () => {
  test("l'ordine è quello dello stat, e ogni file ha il suo pezzo", () => {
    const rows = buildFileRows({
      stat: [stat('b.ts'), stat('a.ts')],
      patch: chunkFor('a.ts') + chunkFor('b.ts'),
      truncated: false,
    });
    expect(rows.map((r) => r.path)).toEqual(['b.ts', 'a.ts']);
    expect(rows.every((r) => !!r.chunk)).toBe(true);
    expect(rows.every((r) => !r.partial)).toBe(true);
  });

  // IL difetto: oltre il tetto del payload il patch si ferma, e i file rimasti
  // fuori sparivano anche dall'elenco. Il conteggio invece c'è sempre.
  test('a patch troncato i file senza pezzo restano NELLA lista', () => {
    const rows = buildFileRows({
      stat: [stat('primo.ts'), stat('secondo.ts'), stat('terzo.ts')],
      patch: chunkFor('primo.ts') + chunkFor('secondo.ts'),
      truncated: true,
    });
    expect(rows.map((r) => r.path)).toEqual(['primo.ts', 'secondo.ts', 'terzo.ts']);
    expect(rows[2]!.chunk).toBeUndefined();
    expect(rows[2]!.stat).toEqual(stat('terzo.ts'));
  });

  test("l'ultimo pezzo di un patch troncato è marcato TAGLIATO, gli altri no", () => {
    const rows = buildFileRows({
      stat: [stat('primo.ts'), stat('secondo.ts')],
      patch: chunkFor('primo.ts') + chunkFor('secondo.ts'),
      truncated: true,
    });
    expect(rows[0]!.partial).toBe(false);
    expect(rows[1]!.partial).toBe(true);
  });

  test('un patch INTERO non marca niente come tagliato', () => {
    const rows = buildFileRows({
      stat: [stat('solo.ts')],
      patch: chunkFor('solo.ts'),
      truncated: false,
    });
    expect(rows[0]!.partial).toBe(false);
  });

  test('un file presente nel patch ma non nello stat non si perde', () => {
    const rows = buildFileRows({ stat: [stat('noto.ts')], patch: chunkFor('noto.ts') + chunkFor('orfano.ts'), truncated: false });
    expect(rows.map((r) => r.path)).toEqual(['noto.ts', 'orfano.ts']);
    expect(rows[1]!.stat).toBeUndefined();
    expect(rows[1]!.chunk).toBeDefined();
  });

  test('nessun file elencato due volte', () => {
    const rows = buildFileRows({
      stat: [stat('doppio.ts'), stat('doppio.ts')],
      patch: chunkFor('doppio.ts'),
      truncated: false,
    });
    expect(rows).toHaveLength(1);
  });

  test('un bundle vuoto non produce righe', () => {
    expect(buildFileRows({ stat: [], patch: '', truncated: false })).toEqual([]);
  });
});

describe('splitPatch', () => {
  test('spezza sul path di DESTINAZIONE, spazi compresi', () => {
    const patch = 'diff --git a/vecchio nome.md b/nuovo nome.md\n@@ -1 +1 @@\n-a\n+b\n';
    expect(splitPatch(patch).map((c) => c.path)).toEqual(['nuovo nome.md']);
  });

  test('un patch vuoto non produce pezzi', () => {
    expect(splitPatch('   \n')).toEqual([]);
  });
});
