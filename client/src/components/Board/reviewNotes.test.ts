/**
 * Line-level review notes on a delivery diff, and the message they become when
 * the human sends the task back: a reject carries a comment the agent can act on.
 *
 * @covers KANBAN-05
 */
import { describe, it, expect } from 'bun:test';
import { parseDiffRows, isCommentable, anchorOf, noteKey, formatReviewNotes, type DiffNote } from './reviewNotes';

// Un patch vero, con due hunk, un'aggiunta, una rimozione e contesto attorno.
const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,5 @@
 import { a } from './a';
-const x = 1;
+const x = 2;
+const y = 3;
 export { x };
@@ -20,3 +21,3 @@ export { x };
 function tail() {
-  return null;
+  return 0;
 }
`;

describe('parseDiffRows', () => {
  const rows = parseDiffRows(PATCH);

  it('non numera l\'intestazione del file', () => {
    const meta = rows.filter((r) => r.kind === 'meta');
    expect(meta.map((r) => r.raw)).toEqual([
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1111111..2222222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
    ]);
    expect(meta.every((r) => r.oldLine === null && r.newLine === null)).toBe(true);
  });

  it('riparte dai numeri dell\'header @@, non dall\'indice nel patch', () => {
    const numbered = rows.filter((r) => r.kind !== 'meta' && r.kind !== 'hunk')
      .map((r) => [r.raw, r.oldLine, r.newLine]);
    expect(numbered).toEqual([
      [" import { a } from './a';", 1, 1],
      ['-const x = 1;', 2, null],
      ['+const x = 2;', null, 2],
      ['+const y = 3;', null, 3],
      [' export { x };', 3, 4],
      [' function tail() {', 20, 21],
      ['-  return null;', 21, null],
      ['+  return 0;', null, 22],
      [' }', 22, 23],
    ]);
  });

  it('un\'aggiunta non consuma il contatore vecchio, una rimozione non consuma il nuovo', () => {
    const add = rows.find((r) => r.raw === '+const y = 3;')!;
    const del = rows.find((r) => r.raw === '-const x = 1;')!;
    expect(add.oldLine).toBeNull();
    expect(del.newLine).toBeNull();
  });

  it('una riga rimossa che inizia per -- non è l\'header ---', () => {
    const rows2 = parseDiffRows(`diff --git a/x.md b/x.md
--- a/x.md
+++ b/x.md
@@ -1,2 +1,1 @@
---- titolo
 resto
`);
    const removed = rows2.find((r) => r.raw === '---- titolo')!;
    expect(removed.kind).toBe('del');
    expect(removed.oldLine).toBe(1);
    // Gli unici meta sono quelli PRIMA del primo @@.
    expect(rows2.filter((r) => r.kind === 'meta').length).toBe(3);
  });

  it('"\\ No newline at end of file" non è una riga del file', () => {
    const rows2 = parseDiffRows(`--- a/x
+++ b/x
@@ -1 +1 @@
-a
\\ No newline at end of file
+a
`);
    const marker = rows2.find((r) => r.kind === 'nonewline')!;
    expect(marker.oldLine).toBeNull();
    expect(marker.newLine).toBeNull();
    expect(rows2.find((r) => r.raw === '+a')!.newLine).toBe(1);
  });

  it('un hunk senza conteggio (@@ -1 +1 @@) parte comunque dal numero giusto', () => {
    const rows2 = parseDiffRows('@@ -7 +9 @@\n ctx\n');
    expect(rows2[1]).toMatchObject({ oldLine: 7, newLine: 9 });
  });

  it('la newline finale del patch non diventa una riga', () => {
    expect(parseDiffRows(PATCH).at(-1)!.raw).toBe(' }');
  });
});

describe('isCommentable / anchorOf', () => {
  const rows = parseDiffRows(PATCH);
  it('header di hunk e meta non sono commentabili', () => {
    expect(rows.filter((r) => isCommentable(r)).every((r) => r.kind !== 'hunk' && r.kind !== 'meta')).toBe(true);
    expect(rows.filter((r) => isCommentable(r)).length).toBe(9);
  });
  it('l\'ancora è il lato nuovo quando esiste, il vecchio sulle righe rimosse', () => {
    expect(anchorOf(rows.find((r) => r.raw === '+const y = 3;')!)).toEqual({ line: 3, side: 'new' });
    expect(anchorOf(rows.find((r) => r.raw === '-const x = 1;')!)).toEqual({ line: 2, side: 'old' });
    expect(anchorOf(rows.find((r) => r.kind === 'hunk')!)).toBeNull();
  });
  it('la chiave distingue i due lati sulla stessa riga', () => {
    expect(noteKey('a.ts', 2, 'new')).not.toBe(noteKey('a.ts', 2, 'old'));
  });
});

describe('formatReviewNotes', () => {
  const notes: DiffNote[] = [
    { id: '2', path: 'b.ts', line: 10, side: 'new', code: '+  return 0;', body: 'perché 0?' },
    { id: '1', path: 'a.ts', line: 88, side: 'new', code: '+const y = 3;', body: 'y non serve' },
    { id: '3', path: 'a.ts', line: 42, side: 'old', code: '-const x = 1;', body: 'era giusto così' },
  ];

  it('ordina per file e per riga, non per ordine di click', () => {
    const out = formatReviewNotes(notes);
    expect(out.indexOf('a.ts:42')).toBeLessThan(out.indexOf('a.ts:88'));
    expect(out.indexOf('a.ts:88')).toBeLessThan(out.indexOf('b.ts:10'));
  });

  it('conta commenti e file nell\'intestazione', () => {
    expect(formatReviewNotes(notes).split('\n')[0]).toBe('Revisione del diff: 3 commenti su 2 file.');
    expect(formatReviewNotes([notes[0]]).split('\n')[0]).toBe('Revisione del diff: 1 commento su 1 file.');
  });

  it('segnala le righe rimosse: quel numero non esiste nel file di adesso', () => {
    expect(formatReviewNotes([notes[2]])).toContain('(riga rimossa, numerazione precedente)');
    expect(formatReviewNotes([notes[0]])).not.toContain('riga rimossa');
  });

  it('cita il codice in un fence che il codice non può sfondare', () => {
    const out = formatReviewNotes([{ ...notes[0], code: '+const md = ```x```;' }]);
    expect(out).toContain('````diff');
    // Il fence chiude: numero pari di recinti da 4 backtick.
    expect((out.match(/^````$/gm) ?? []).length).toBe(1);
  });

  it('chiude dicendo all\'agente cosa fare dopo', () => {
    expect(formatReviewNotes(notes).trimEnd().endsWith('rimetti il task in review.')).toBe(true);
  });
});
