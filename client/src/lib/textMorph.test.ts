/**
 * Cosa si anima quando una frase viene riscritta.
 *
 * Le due cose che questo file tiene ferme, e che nessun compilatore vede:
 *  1. si animano SOLO le lettere nuove (prefisso e suffisso in comune sono la
 *     parte che dice «e' sempre lo stesso task», e non si muove);
 *  2. la durata e' un BUDGET: una parola e una riga intera ci mettono lo stesso
 *     tempo, perche' sopra le ~26 lettere il passo si stringe da solo. Senza
 *     questo, la stessa animazione sarebbe elegante su «footer» e interminabile
 *     su un titolo lungo.
  * @covers MORPH-01
 */
import { describe, test, expect } from 'bun:test';

import {
  morphPlan,
  morphWordChunks,
  MORPH_MAX_CHARS,
  MORPH_STAGGER_BUDGET_MS,
  MORPH_STEP_MS,
} from './textMorph';

describe('morphPlan', () => {
  test('testo identico: niente da animare', () => {
    expect(morphPlan('Rifare il footer', 'Rifare il footer')).toBeNull();
  });

  test('una coda aggiunta anima solo la coda', () => {
    const p = morphPlan('Rifare il footer', 'Rifare il footer del sito');
    expect(p?.kind).toBe('letters');
    expect(p?.prefix).toBe('Rifare il footer');
    expect(p?.changed).toBe(' del sito');
    expect(p?.suffix).toBe('');
  });

  test('una parola cambiata in mezzo lascia fermi i due capi', () => {
    const p = morphPlan('Rifare il footer', 'Rifare il header');
    expect(p?.kind).toBe('letters');
    expect(p?.prefix).toBe('Rifare il ');
    expect(p?.suffix).toBe('er');
    // Il pezzo nuovo ricostruisce la frase, sempre: e' l'invariante che rende
    // impossibile disegnare un testo diverso da quello vero.
    expect(`${p?.prefix}${p?.changed}${p?.suffix}`).toBe('Rifare il header');
  });

  test('una riscrittura che ha solo TOLTO non ha lettere da far entrare', () => {
    const p = morphPlan('Rifare il footer del sito', 'Rifare il footer');
    expect(p?.kind).toBe('block');
  });

  test('oltre la soglia non e\' una correzione, e\' un\'altra frase', () => {
    const p = morphPlan('a', 'b'.repeat(MORPH_MAX_CHARS + 1));
    expect(p?.kind).toBe('block');
  });

  test('un testo che compare per la prima volta non e\' un cambio', () => {
    expect(morphPlan('', 'Rifare il footer')?.kind).toBe('block');
  });

  test('la scaletta sta nel budget, corta o lunga che sia la frase', () => {
    const corta = morphPlan('x', 'xciao');
    expect(corta?.stepMs).toBe(MORPH_STEP_MS);
    const lunga = morphPlan('x', `x${'a'.repeat(MORPH_MAX_CHARS - 1)}`);
    expect(lunga?.stepMs).toBeLessThan(MORPH_STEP_MS);
    // L'ultima lettera parte entro il budget: e' la promessa che tiene la
    // durata indipendente dalla lunghezza.
    const n = MORPH_MAX_CHARS - 1;
    expect((n - 1) * (lunga?.stepMs ?? 0)).toBeLessThanOrEqual(MORPH_STAGGER_BUDGET_MS);
  });

  test('un\'emoji e\' UNA lettera, non due mezze', () => {
    const p = morphPlan('Rilascio', 'Rilascio 🚀');
    expect(p?.kind).toBe('letters');
    expect(Array.from(p?.changed ?? '')).toEqual([' ', '🚀']);
  });
});

describe('morphWordChunks', () => {
  test('le parole restano intere e gli spazi sono pezzi a se\'', () => {
    expect(morphWordChunks(' del sito')).toEqual([' ', 'del', ' ', 'sito']);
  });

  test('niente da spezzare', () => {
    expect(morphWordChunks('')).toEqual([]);
  });
});
