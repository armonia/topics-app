/**
 * Le due promesse di `MorphText` che nessun compilatore controlla.
 *
 * 1. A RIPOSO NON ESISTE. Il titolo di una card e' testo e basta: nessun
 *    involucro, nessuna classe, nessuna lettera in un `span`. E' la promessa
 *    che rende sostenibile metterlo su cinquanta card insieme, e si romperebbe
 *    con un innocuo `<span>{text}</span>` di comodo.
 * 2. LE SUPERFICI LO MONTANO DAVVERO. Il titolo che viene riscritto e' quello
 *    della card sulla board e quello del drawer: se un giorno uno dei due torna
 *    a stampare `task.text` a mano, la riscrittura li' ridiventa muta senza che
 *    niente diventi rosso. Il controllo e' sul SORGENTE, con lo stesso metodo
 *    (e lo stesso motivo) di `GlobalCapControl.test.tsx`: `Card.tsx` e
 *    `TaskDetail.tsx` tirano dentro l'API, gli store e mezzo layout, quindi in
 *    un test unitario non si montano.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { MorphText } from './MorphText';

describe('MorphText', () => {
  test('a riposo rende il testo e nient\'altro', () => {
    expect(renderToStaticMarkup(<MorphText text="Rifare il footer" />)).toBe('Rifare il footer');
  });

  test('un testo vuoto non inventa nodi', () => {
    expect(renderToStaticMarkup(<MorphText text="" />)).toBe('');
  });
});

describe('chi lo monta', () => {
  const sorgente = (f: string) => readFileSync(join(import.meta.dir, '..', 'Board', f), 'utf8');

  test('la card della board disegna il titolo con MorphText', () => {
    const s = sorgente('Card.tsx');
    expect(s).toContain('<MorphText text={task.text} />');
  });

  test('il drawer del task pure', () => {
    const s = sorgente('TaskDetail.tsx');
    expect(s).toContain('<MorphText text={task.text} />');
  });
});
