/**
 * The usage panel says how many side calls were NOT measured.
 *
 * Providers without a usage (ACP; Codex and Muse before `--json`) leave a row
 * with no tokens: their calls are in the count and out of the dollars. Without
 * the words "not measured" the dollars read as the whole bill.
 *
 * @covers USAGE-24
 */
import { describe, expect, test } from 'bun:test';
import IT from '../../lib/i18n-it';
import { interpolate } from '../../lib/i18n';
import { sideCallsLine } from './sideCallsLine';

const tr = (key: string, vars?: Record<string, string | number>) => interpolate((IT as Record<string, string>)[key] ?? key, vars);
const base = { calls: 0, unmeasured: 0, unpriced: 0, failed: 0, costUsd: 0, byPurpose: [] };

describe('sideCallsLine', () => {
  test('N calls, M not measured, then the dollars', () => {
    expect(sideCallsLine({ ...base, calls: 12, unmeasured: 3 }, '0,42 $', tr))
      .toBe('Chiamate di servizio fuori dalle chat: 12 chiamate, 3 non misurate, 0,42 $');
  });

  test('every call measured: no count of zero', () => {
    expect(sideCallsLine({ ...base, calls: 4 }, '0,10 $', tr))
      .toBe('Chiamate di servizio fuori dalle chat: 4 chiamate, 0,10 $');
  });

  test('calls without a price and failed calls are named too', () => {
    expect(sideCallsLine({ ...base, calls: 5, unpriced: 2, failed: 2 }, '0,00 $', tr))
      .toBe('Chiamate di servizio fuori dalle chat: 5 chiamate, 2 senza prezzo, 2 fallite, 0,00 $');
  });
});
