import { describe, expect, test } from 'bun:test';
import { chipKey } from './chipKey';
import { DISPATCH_CHIP } from './constants';

describe('chip di una consegna', () => {
  test('una consegna del sistema non e\' una consegna dell\'agent', () => {
    expect(chipKey('delivered', 'system')).toBe('delivered_by_system');
  });

  test('la consegna vera resta quella verde', () => {
    expect(chipKey('delivered', 'agent')).toBe('delivered');
    expect(chipKey('delivered', null)).toBe('delivered');
    expect(chipKey('delivered', undefined)).toBe('delivered');
  });

  test('gli altri stati non li tocca', () => {
    for (const s of ['working', 'failed', 'needs_input', 'queued']) {
      expect(`${s}→${chipKey(s, 'system')}`).toBe(`${s}→${s}`);
    }
  });

  test('la chiave nuova esiste davvero nella tabella, o la card resta MUTA', () => {
    // DispatchChip torna null su una chiave che non c'e': senza questa riga il
    // refactor si vedrebbe solo come un chip sparito, non come un errore.
    expect(DISPATCH_CHIP.delivered_by_system).toBeDefined();
    expect(DISPATCH_CHIP.delivered_by_system!.text).not.toBe(DISPATCH_CHIP.delivered!.text);
  });
});
