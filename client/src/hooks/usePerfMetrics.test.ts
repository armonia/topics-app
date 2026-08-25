/**
 * `formatCpuPercent` — perché una misura piccola non deve sparire.
 *
 * Il chip CPU della status bar era gated su `cpu.total > 0`, e il valore arrivava
 * già passato per `Math.round`. Due effetti sommati: tutto ciò che stava sotto lo
 * 0,5% diventava `0`, e uno `0` faceva nascondere il chip. Risultato: l'app FERMA
 * — cioè esattamente quando "0%" è l'informazione utile — perdeva il contatore, e
 * sembrava un bug intermittente ("ogni tanto sparisce") mentre era il
 * comportamento scritto.
 *
 * Ora `null` è l'unico "non misurato" (lo decide lo shell, che sa se aveva una
 * baseline) e questo formatter tiene visibile una misura reale ma minuscola.
  * @covers SYSTEM-01
 */
import { describe, test, expect } from 'bun:test';
import { formatCpuPercent } from './usePerfMetrics';

describe('formatCpuPercent', () => {
  test('uno zero MISURATO si scrive 0, non sparisce', () => {
    expect(formatCpuPercent(0)).toBe('0');
  });

  test('sotto l\'1% si scrive <1 invece di essere arrotondato a zero', () => {
    // È il caso che rompeva tutto: 0,4% → Math.round → 0 → chip nascosto.
    expect(formatCpuPercent(0.4)).toBe('<1');
    expect(formatCpuPercent(0.05)).toBe('<1');
    expect(formatCpuPercent(0.999)).toBe('<1');
  });

  test('da 1% in su arrotonda', () => {
    expect(formatCpuPercent(1)).toBe('1');
    expect(formatCpuPercent(6.67)).toBe('7');
    expect(formatCpuPercent(99.4)).toBe('99');
  });

  test('oltre 100 resta oltre 100 (somma per-core, come Activity Monitor)', () => {
    expect(formatCpuPercent(224)).toBe('224');
  });

  test('un valore non finito o negativo non produce output assurdo', () => {
    expect(formatCpuPercent(Number.NaN)).toBe('0');
    expect(formatCpuPercent(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatCpuPercent(-3)).toBe('0');
  });
});
