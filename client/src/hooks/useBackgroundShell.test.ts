/**
 * @covers BGSHELL-01, BGSHELL-03
 */
import { describe, expect, test } from 'bun:test';
import { pickShellEntry, parseShellIdFromStartResult } from './useBackgroundShell';

/**
 * A quale shell si aggancia una card.
 *
 * Il rischio qui non è la card muta — quella è la vecchia resa, e va bene: è
 * la card che mostra l'output della shell di UN'ALTRA chat. La prima shell di
 * ogni sessione si chiama `bash_1`, quindi l'id da solo non identifica niente.
 * Ogni test che segue difende quel confine.
 */

const shell = (processId: string, status = 'running', shellId = 'bash_1') => ({
  processId, status, shellId, source: 'shell',
});

describe('a quale shell si aggancia la card', () => {
  test('trova la sua per chiave sessione+id', () => {
    const rows = [shell('shell:sess-a:bash_1'), shell('shell:sess-b:bash_1')];
    expect(pickShellEntry(rows, 'bash_1', 'sess-b')?.processId).toBe('shell:sess-b:bash_1');
  });

  test('con due sessioni e nessuna sessionKey non indovina', () => {
    const rows = [shell('shell:sess-a:bash_1'), shell('shell:sess-b:bash_1')];
    expect(pickShellEntry(rows, 'bash_1')).toBeUndefined();
  });

  test('senza sessionKey ma con un solo candidato si aggancia', () => {
    const rows = [shell('shell:sess-a:bash_1')];
    expect(pickShellEntry(rows, 'bash_1')?.processId).toBe('shell:sess-a:bash_1');
  });

  test('sessionKey che non corrisponde: nessun ripiego sull altra chat', () => {
    const rows = [shell('shell:sess-a:bash_1')];
    expect(pickShellEntry(rows, 'bash_1', 'sess-z')).toBeUndefined();
  });

  test('a parità di chiave vince la voce viva', () => {
    const rows = [
      { ...shell('shell:sess-a:bash_1', 'done'), scriptName: 'vecchia' },
      { ...shell('shell:sess-a:bash_1', 'running'), scriptName: 'viva' },
    ];
    expect(pickShellEntry(rows, 'bash_1', 'sess-a')?.scriptName).toBe('viva');
  });

  test('ignora i processi che non sono shell', () => {
    const rows = [{ processId: 'shell:sess-a:bash_1', status: 'running', shellId: 'bash_1', source: 'script' }];
    expect(pickShellEntry(rows, 'bash_1', 'sess-a')).toBeUndefined();
  });

  test('senza shellId non cerca niente', () => {
    expect(pickShellEntry([shell('shell:sess-a:bash_1')], undefined, 'sess-a')).toBeUndefined();
  });
});

describe("l'id della shell letto dal risultato della Bash", () => {
  test('la forma in prosa del CLI', () => {
    expect(parseShellIdFromStartResult('Command running in background with ID: bash_1')).toBe('bash_1');
  });

  test('la forma JSON, se un giorno smette di rispondere in prosa', () => {
    expect(parseShellIdFromStartResult('{"bash_id":"bash_42"}')).toBe('bash_42');
  });

  test('niente risultato, niente id', () => {
    expect(parseShellIdFromStartResult(undefined)).toBeUndefined();
    expect(parseShellIdFromStartResult('')).toBeUndefined();
  });

  test('un output che non annuncia nessuna shell non inventa un id', () => {
    expect(parseShellIdFromStartResult('total 12\ndrwxr-xr-x  4 me  staff')).toBeUndefined();
  });
});
