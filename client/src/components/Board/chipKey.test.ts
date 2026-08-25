/**
 * The dispatch chip key of a delivery: a system move is not an agent delivery,
 * and a card with no branch, commit or file behind it is not a delivery at all.
 *
 * @covers KANBAN-07
 */
import { describe, expect, test } from 'bun:test';
import { chipKey, taskHasWork } from './chipKey';
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
    // DispatchChip returns null for a key that is not there: without this line
    // the refactor would show up as a missing chip, not as an error.
    expect(DISPATCH_CHIP.delivered_by_system).toBeDefined();
    expect(DISPATCH_CHIP.delivered_by_system!.text).not.toBe(DISPATCH_CHIP.delivered!.text);
  });
});

describe('una card senza niente dietro', () => {
  test("nessun ramo, nessun commit, nessun file: non e' una consegna", () => {
    expect(chipKey('delivered', 'agent', false)).toBe('delivered_empty');
    expect(chipKey('delivered', 'system', false)).toBe('delivered_empty');
  });

  test('con del lavoro dietro, chi ha mosso la card torna a contare', () => {
    expect(chipKey('delivered', 'agent', true)).toBe('delivered');
    expect(chipKey('delivered', 'system', true)).toBe('delivered_by_system');
  });

  test('le tre colonne che dicono che qualcosa e rimasto', () => {
    expect(taskHasWork({ deliveryBranch: 'topics/x' })).toBe(true);
    expect(taskHasWork({ deliveryCommit: 'abc1234' })).toBe(true);
    expect(taskHasWork({ deliveryFilesChanged: 3 })).toBe(true);
    expect(taskHasWork({ deliveryFilesChanged: 0 })).toBe(false);
    expect(taskHasWork({})).toBe(false);
  });

  test('anche questa chiave esiste davvero, o la card resta MUTA', () => {
    expect(DISPATCH_CHIP.delivered_empty).toBeDefined();
  });
});
