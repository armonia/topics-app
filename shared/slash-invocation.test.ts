/**
 * Riconoscere il messaggio che È un comando — e NON riconoscere quello che non
 * lo è, che è la metà che conta: un'etichetta falsa su un messaggio normale è
 * peggio di nessuna etichetta.
 *
 * @covers SKILL-03
 */

import { describe, expect, test } from 'bun:test';
import { parseSlashInvocation } from './slash-invocation';

describe('parseSlashInvocation', () => {
  test('il comando secco', () => {
    expect(parseSlashInvocation('/recap')).toEqual({ command: 'recap' });
    expect(parseSlashInvocation('  /vai  ')).toEqual({ command: 'vai' });
  });

  test('col suo argomento', () => {
    expect(parseSlashInvocation('/vai solo il bug X')).toEqual({ command: 'vai', args: 'solo il bug X' });
  });

  test('i nomi con due punti e trattini (le skill dei marketplace)', () => {
    expect(parseSlashInvocation('/jarvis-custom-skills:master')).toEqual({ command: 'jarvis-custom-skills:master' });
    expect(parseSlashInvocation('/opsx:propose')).toEqual({ command: 'opsx:propose' });
  });

  test('un PERCORSO non è un comando', () => {
    expect(parseSlashInvocation('/Users/utente/Projects/topics-app')).toBeNull();
    expect(parseSlashInvocation('/tmp/x.png')).toBeNull();
  });

  test('prosa che comincia per barra non è un comando', () => {
    expect(parseSlashInvocation('/ ciao')).toBeNull();
    expect(parseSlashInvocation('//commento')).toBeNull();
    expect(parseSlashInvocation('/2 volte')).toBeNull();
  });

  test('più righe: è un messaggio, non un comando', () => {
    expect(parseSlashInvocation('/recap\ne poi dimmi altro')).toBeNull();
  });

  test('vuoto e non-stringa non esplodono', () => {
    expect(parseSlashInvocation('')).toBeNull();
    expect(parseSlashInvocation(undefined as unknown as string)).toBeNull();
  });
});
