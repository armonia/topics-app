/**
 * La regola dei comandi nascosti dietro l'hover, provata dove vive.
 *
 * Le due cose che questo file impedisce di rompere in silenzio:
 *  · senza puntatore, un comando nascosto NON deve restare cliccabile
 *    (`pointer-events-none` nel ramo touch, non fuori dal ternario);
 *  · le classi `group-hover/*` devono essere LETTERALI nel sorgente, o
 *    Tailwind non le genera e la regola muore senza dirlo.
  * @covers GESTURE-03
 */
import { describe, expect, it } from 'bun:test';
import { hoverRevealClass, HOVER_REVEAL_HIDDEN } from './hoverReveal';

describe('hoverRevealClass', () => {
  it('col puntatore si scopre al passaggio del mouse', () => {
    expect(hoverRevealClass(true)).toContain('opacity-0');
    expect(hoverRevealClass(true)).toContain('group-hover:opacity-100');
    expect(hoverRevealClass(true, 'node')).toContain('group-hover/node:opacity-100');
  });

  it('col puntatore NON spegne mai i pointer-events', () => {
    // Il difetto opposto: `pointer-events-none` scritto fuori dal ternario
    // ucciderebbe il comando anche col mouse, perche' anche
    // `group-hover:pointer-events-auto` sta dentro `@media (hover: hover)`.
    for (const g of ['self', 'node', 'hdr', 'hunk', 'tool'] as const) {
      expect(hoverRevealClass(true, g)).not.toContain('pointer-events-none');
    }
  });

  it('senza puntatore sparisce DAVVERO: niente da colpire alla cieca', () => {
    expect(hoverRevealClass(false)).toBe(HOVER_REVEAL_HIDDEN);
    expect(hoverRevealClass(false)).toContain('pointer-events-none');
    expect(hoverRevealClass(false, 'node')).toContain('pointer-events-none');
  });

  it('senza puntatore e senza altro percorso, il comando si vede', () => {
    // `touch: 'shown'` = nessuna classe di opacita': il comando resta al suo
    // posto, visibile e cliccabile. E' l'unico modo di NON perderlo quando non
    // c'e' un menu dove rifugiarsi.
    expect(hoverRevealClass(false, 'hdr', { touch: 'shown' })).toBe('');
    expect(hoverRevealClass(false, 'hdr', { touch: 'shown' })).not.toContain('opacity-0');
  });

  it('nessun ramo lascia opacity-0 senza pointer-events-none', () => {
    // L'invariante che riassume il difetto originale, su tutta la matrice.
    for (const g of ['self', 'node', 'files', 'hdr', 'git', 'hunk', 'remote', 'row', 'prev', 'preview', 'tool', 'toolgroup'] as const) {
      for (const touch of ['hidden', 'shown'] as const) {
        for (const hasHover of [true, false]) {
          const cls = hoverRevealClass(hasHover, g, { touch });
          if (cls.includes('opacity-0') && !hasHover) {
            expect(cls).toContain('pointer-events-none');
          }
        }
      }
    }
  });
});
