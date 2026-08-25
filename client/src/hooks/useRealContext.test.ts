/**
 * `formatTokens` è la parte pura del ring: il resto dell'hook è React + fetch.
 * Il numero che scrive finisce dentro un cerchietto da 14px e nel tooltip, e
 * l'unico modo di sbagliarlo è arrotondare male ai bordi (999 → "1k" quando
 * ancora non lo è, 1M che diventa "1000k").
 *
 * @covers CTX-01
 */
import { describe, it, expect } from 'bun:test';
import { formatTokens } from './useRealContext';

describe('formatTokens', () => {
  it('lascia i numeri sotto il migliaio pieni', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('passa a k esattamente da mille', () => {
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(1_499)).toBe('1k');
    expect(formatTokens(1_500)).toBe('2k');
    expect(formatTokens(148_231)).toBe('148k');
    expect(formatTokens(200_000)).toBe('200k');
  });

  it('passa a M da un milione, con un decimale finché serve', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(1_047_576)).toBe('1.0M');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    // Sopra i dieci milioni il decimale è rumore: la finestra non esiste
    // ancora, ma il ring non deve stampare "12.3M" dove basta "12M".
    expect(formatTokens(12_300_000)).toBe('12M');
  });

  it('non stampa mai "1000k" al confine', () => {
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_500)).toBe('1.0M');
    expect(formatTokens(999_999)).toBe('1.0M');
    expect(formatTokens(1_000_001)).toBe('1.0M');
  });
});
