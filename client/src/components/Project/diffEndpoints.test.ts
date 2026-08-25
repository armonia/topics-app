/**
 * Which two sides the diff viewer compares for Staged, Changes and a commit,
 * which name each side uses across a rename, and how the end is labelled.
 *
 * @covers FILE-02
 */
import { describe, expect, test } from 'bun:test';
import { diffEndpoints, endLabel } from './diffEndpoints';

const f = (path: string, origPath?: string) => ({ path, origPath });

describe('diffEndpoints', () => {
  test('«Staged» confronta HEAD con l’INDICE: e cosa sto per committare', () => {
    expect(diffEndpoints(f('a.ts'), { kind: 'worktree', group: 'staged' })).toEqual({
      left: { from: 'rev', rev: 'HEAD', path: 'a.ts' },
      right: { from: 'index', path: 'a.ts' },
    });
  });

  test('«Changes» confronta l’INDICE col disco: e cosa NON ho ancora messo in stage', () => {
    expect(diffEndpoints(f('a.ts'), { kind: 'worktree', group: 'unstaged' })).toEqual({
      left: { from: 'index', path: 'a.ts' },
      right: { from: 'disk', path: 'a.ts' },
    });
  });

  test('le due coppie sono DIVERSE — era tutto il difetto', () => {
    // Prima ce n'era una sola per entrambi: `HEAD` contro il disco, cioe' la
    // SOMMA. Su un file `MM` — l'uscita garantita dello staging per blocco di
    // questo stesso pannello — chi metteva in stage meta' file vedeva sotto
    // anche cio' che non aveva messo in stage.
    const staged = diffEndpoints(f('a.ts'), { kind: 'worktree', group: 'staged' });
    const unstaged = diffEndpoints(f('a.ts'), { kind: 'worktree', group: 'unstaged' });
    expect(staged).not.toEqual(unstaged);
    // E nessuna delle due e' la vecchia coppia HEAD↔disco.
    expect(staged.right.from).not.toBe('disk');
    expect(unstaged.left.from).not.toBe('rev');
  });

  test('un commit si confronta col suo PADRE', () => {
    expect(diffEndpoints(f('a.ts'), { kind: 'commit', hash: 'abc1234' })).toEqual({
      left: { from: 'rev', rev: 'abc1234^', path: 'a.ts' },
      right: { from: 'rev', rev: 'abc1234', path: 'a.ts' },
    });
  });

  describe('rename', () => {
    test('il lato SINISTRO usa il nome vecchio', () => {
      // `git show HEAD:<nuovo>` esce non-zero (a HEAD quel nome non esisteva) e
      // la rotta risponde 200 col corpo vuoto: lato sinistro bianco, file
      // intero in verde. Un rename con una riga cambiata si presentava come
      // 9 KB di aggiunte.
      const e = diffEndpoints(f('nuovo.ts', 'vecchio.ts'), { kind: 'worktree', group: 'staged' });
      expect(e.left).toEqual({ from: 'rev', rev: 'HEAD', path: 'vecchio.ts' });
      expect(e.right).toEqual({ from: 'index', path: 'nuovo.ts' });
    });

    test('vale anche nella cronologia, dove i rename si incontrano di piu', () => {
      const e = diffEndpoints(f('nuovo.ts', 'vecchio.ts'), { kind: 'commit', hash: 'deadbee' });
      expect(e.left).toEqual({ from: 'rev', rev: 'deadbee^', path: 'vecchio.ts' });
      expect(e.right).toEqual({ from: 'rev', rev: 'deadbee', path: 'nuovo.ts' });
    });

    test('a DESTRA il nome vecchio non compare mai: quel contenuto non esiste li', () => {
      for (const src of [
        { kind: 'worktree', group: 'staged' } as const,
        { kind: 'worktree', group: 'unstaged' } as const,
        { kind: 'commit', hash: 'abc' } as const,
      ]) {
        expect(diffEndpoints(f('nuovo.ts', 'vecchio.ts'), src).right.path).toBe('nuovo.ts');
      }
    });

    test('senza rename i due lati usano lo stesso nome', () => {
      const e = diffEndpoints(f('a.ts'), { kind: 'commit', hash: 'abc' });
      expect(e.left.path).toBe('a.ts');
      expect(e.right.path).toBe('a.ts');
    });
  });

  test('un file in conflitto si legge dall’albero: e li che stanno i marcatori', () => {
    const e = diffEndpoints(f('a.ts'), { kind: 'worktree', group: 'conflicted' });
    expect(e.right).toEqual({ from: 'disk', path: 'a.ts' });
  });
});

describe('endLabel', () => {
  test('dice quale delle tre cose si sta guardando', () => {
    expect(endLabel({ from: 'disk', path: 'a' })).toBe('in lavorazione');
    expect(endLabel({ from: 'index', path: 'a' })).toBe('in stage');
    expect(endLabel({ from: 'rev', rev: 'HEAD', path: 'a' })).toBe('HEAD');
  });

  test('un hash si accorcia, cosi l’intestazione resta leggibile', () => {
    expect(endLabel({ from: 'rev', rev: 'abc1234def5678', path: 'a' })).toBe('abc1234');
  });
});
