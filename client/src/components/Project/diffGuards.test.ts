/**
 * When the diff viewer refuses to render a body: a binary file on either side,
 * bytes that only look like text, and the 100 KB cap told apart from a 404.
 *
 * @covers FILE-02
 */
import { describe, expect, test } from 'bun:test';
import { isBinaryForDiff, looksBinary, isTooLarge } from './diffGuards';
import { ApiError } from '../../lib/api';
import type { GitFile } from '../../types';

const file = (p: Partial<GitFile>): GitFile => ({ path: 'x', status: 'M ', ...p } as GitFile);

describe('isBinaryForDiff', () => {
  test('il flag su UN lato solo basta', () => {
    // Un PNG appena messo in stage ha il flag su `staged` e non su `unstaged`:
    // chiedere il lato del gruppo cliccato lo farebbe passare per testo.
    expect(isBinaryForDiff(file({ staged: { added: 0, removed: 0, binary: true } }))).toBe(true);
    expect(isBinaryForDiff(file({ unstaged: { added: 0, removed: 0, binary: true } }))).toBe(true);
  });

  test('un file di testo con dei conteggi non e binario', () => {
    expect(isBinaryForDiff(file({ unstaged: { added: 12, removed: 3 } }))).toBe(false);
  });

  test('senza voce, e senza conteggi, non si dichiara niente', () => {
    expect(isBinaryForDiff(undefined)).toBe(false);
    expect(isBinaryForDiff(file({}))).toBe(false);
  });
});

describe('looksBinary', () => {
  test('un testo con accenti NON e binario', () => {
    // Il controllo naif «contiene byte strani» boccerebbe mezzo repo italiano.
    expect(looksBinary('perché però città più così — è un test\n'.repeat(50))).toBe(false);
  });

  test('un PNG letto come testo si riconosce', () => {
    // Cio' che resta di un binario decodificato: una pioggia di U+FFFD. Su un
    // PNG vero da 10 KB sono ~4500 su 19 KB di caratteri.
    const finto = '�'.repeat(400) + 'PNG\r\n' + '�'.repeat(400);
    expect(looksBinary(finto)).toBe(true);
  });

  test('i byte NUL contano come il carattere di sostituzione', () => {
    expect(looksBinary('a\0b\0c\0d\0'.repeat(20))).toBe(true);
  });

  test('un U+FFFD isolato in un testo lungo non basta', () => {
    // Un documento che PARLA di codifiche puo' contenerne uno per davvero.
    expect(looksBinary('testo normale e lungo. '.repeat(100) + '�')).toBe(false);
  });

  test('stringa vuota: niente da dichiarare', () => {
    expect(looksBinary('')).toBe(false);
  });
});

describe('isTooLarge', () => {
  test('il 413 del tetto dei 100 KB si riconosce', () => {
    // E' il caso che disegnava il file intero come CANCELLATO: il client
    // inghiottiva il 413 e passava stringa vuota al lato destro.
    expect(isTooLarge(new ApiError(413, 'File too large (max 100KB)'))).toBe(true);
  });

  test('un 404 NON e «troppo grande»: e il file davvero rimosso', () => {
    // E lì la rimozione integrale e' la verita', quindi il diff va disegnato.
    expect(isTooLarge(new ApiError(404, 'File not found'))).toBe(false);
  });

  test('un errore qualunque non e un 413', () => {
    expect(isTooLarge(new Error('boom'))).toBe(false);
    expect(isTooLarge(undefined)).toBe(false);
  });
});
