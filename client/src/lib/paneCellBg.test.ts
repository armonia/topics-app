import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { paneCellBg } from './paneCellBg';

/**
 * LA TINTA DI UNA CELLA LA DECIDE IL TIPO DELLA PANE, non dove sta nell'albero.
 *
 * La cella che ospita una pane browser non ha testo denso da tenere nitido:
 * l'unica sua parte che si vede e' la striscia di chrome in cima (barra delle
 * tab + toolbar dell'indirizzo, nessuna delle due con un fondo proprio), e il
 * contenuto web dipinge il suo opaco per conto suo. Quindi sta nel livello
 * smerigliato con chat e kanban, e non nel livello opaco.
 *
 * Era gia' cosi', ma lo diceva una regola CSS che guardava la FORMA del DOM
 * (`:has(> [data-testid="browser-native-panel"])`): dove un chiamante interpone
 * un div — le tab browser di una task sulla board — non agganciava, e la stessa
 * pane usciva di due tinte diverse a seconda di chi la montava.
 */
describe('paneCellBg', () => {
  it('mette la pane browser nel livello smerigliato, come chat e kanban', () => {
    expect(paneCellBg('browser')).toBe('pane-frost');
    expect(paneCellBg('chat')).toBe('pane-frost');
    expect(paneCellBg('kanban')).toBe('pane-frost');
  });

  it('lascia trasparenti le pane che si dipingono il chrome da sole', () => {
    expect(paneCellBg('project')).toBe('');
    expect(paneCellBg('terminal')).toBe('');
  });

  it("tiene il fondo opaco dove il testo e' denso", () => {
    expect(paneCellBg('files')).toBe('bg-surface');
  });

  it("nessuna regola CSS decide piu' il fondo della cella browser dalla forma del DOM", () => {
    const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');
    const regole = css
      .split('\n')
      .filter((riga) => !riga.trimStart().startsWith('*') && !riga.trimStart().startsWith('/*'))
      .filter((riga) => riga.includes('browser-native-panel'));
    expect(regole).toEqual([]);
  });
});
