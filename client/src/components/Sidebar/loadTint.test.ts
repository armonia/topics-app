/**
 * The load ramp, pinned where it actually decides something: what it does with
 * a part it could not measure, and that the colour really does move instead of
 * stepping between three fixed values.
 *
 * @covers STATUSLINE-01
 */
import { describe, expect, test } from 'bun:test';
import { CPU_CEILING, livelloCarico, parolaCarico, tintaCarico } from './loadTint';

describe('the load level', () => {
  test('the worst part wins: a busy CPU is not averaged away by calm memory', () => {
    const { livello } = livelloCarico({ cpu: CPU_CEILING, memMB: 100, memCeilingMB: 8000 });
    expect(livello).toBe(1);
  });

  test('a part nobody could measure is left out, not counted as zero', () => {
    // The phone does not expose its processes, so memory arrives null. Counting
    // it as zero would halve the reported load of a machine at full CPU, which
    // is an invented reassurance rather than a missing measure.
    const senzaMemoria = livelloCarico({ cpu: 40, memMB: null, memCeilingMB: 8000 });
    const conMemoriaCalma = livelloCarico({ cpu: 40, memMB: 0, memCeilingMB: 8000 });
    expect(senzaMemoria.livello).toBe(conMemoriaCalma.livello);
    expect(senzaMemoria.misurato).toBe(true);
  });

  test('nothing measured at all is zero AND says it is not measured', () => {
    const r = livelloCarico({ cpu: null, memMB: null, memCeilingMB: 0 });
    expect(r).toEqual({ livello: 0, misurato: false });
  });

  test('past the ceiling it saturates instead of running off the scale', () => {
    expect(livelloCarico({ cpu: 400, memMB: null, memCeilingMB: 0 }).livello).toBe(1);
  });

  test('a ceiling of zero is not a division by zero', () => {
    expect(livelloCarico({ cpu: null, memMB: 500, memCeilingMB: 0 })).toEqual({ livello: 0, misurato: false });
  });
});

describe('the tint', () => {
  test('it is a ramp: two nearby levels are two different colours', () => {
    // This is the assertion three discrete states would fail, and the whole
    // reason the ramp exists: at 49% and 51% of a threshold the machine is
    // doing the same thing, and a stepped scale said two different words.
    expect(tintaCarico(0.50)).not.toBe(tintaCarico(0.55));
  });

  test('it walks from green to red, and never past either end', () => {
    expect(tintaCarico(0)).toContain('hsl(150');
    expect(tintaCarico(1)).toContain('hsl(0');
    // Out of range input cannot produce a hue outside the ramp: the dot is fed
    // by live metrics, and one bad sample must not paint it blue.
    expect(tintaCarico(-3)).toBe(tintaCarico(0));
    expect(tintaCarico(9)).toBe(tintaCarico(1));
    expect(tintaCarico(Number.NaN)).toBe(tintaCarico(0));
  });
});

describe('the word', () => {
  test('three words for the hover, in order', () => {
    expect(parolaCarico(0.1)).toBe('calmo');
    expect(parolaCarico(0.6)).toBe('caldo');
    expect(parolaCarico(0.9)).toBe('carico');
  });
});
