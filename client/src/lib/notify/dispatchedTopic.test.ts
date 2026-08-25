/**
 * Whether a dispatched agent is still working, and which of its turns are
 * noise that must not interrupt anyone.
 *
 * @covers MUTE-01
 */
import { describe, test, expect } from 'bun:test';
import { isAgentTurnNoise } from './dispatchedTopic';
import { ACTIVE_DISPATCH_STATES, isAgentWorking } from '../board';

describe('isAgentWorking', () => {
  test('gli stati attivi sono esattamente tre', () => {
    expect([...ACTIVE_DISPATCH_STATES]).toEqual(['queued', 'starting', 'working']);
  });

  test('vero solo dentro quei tre', () => {
    for (const s of ACTIVE_DISPATCH_STATES) expect(isAgentWorking(s)).toBe(true);
  });

  test('falso per un task fermo, e per l\'assenza di task', () => {
    for (const s of ['waiting', 'delivered', 'needs_input', 'exhausted', 'failed', '']) {
      expect(isAgentWorking(s)).toBe(false);
    }
    expect(isAgentWorking(null)).toBe(false);
    expect(isAgentWorking(undefined)).toBe(false);
  });
});

describe('isAgentTurnNoise', () => {
  test('mentre l\'agente lavora, la fine turno si zittisce', () => {
    expect(isAgentTurnNoise('awaiting-user', 'working')).toBe(true);
    expect(isAgentTurnNoise('completed', 'working')).toBe(true);
    expect(isAgentTurnNoise('awaiting-user', 'queued')).toBe(true);
    expect(isAgentTurnNoise('completed', 'starting')).toBe(true);
  });

  test('approvazione ed errore passano SEMPRE: sono azionabili', () => {
    for (const s of ACTIVE_DISPATCH_STATES) {
      expect(isAgentTurnNoise('awaiting-approval', s)).toBe(false);
      expect(isAgentTurnNoise('error', s)).toBe(false);
    }
  });

  test('nessun task sul topic: niente si zittisce', () => {
    expect(isAgentTurnNoise('awaiting-user', null)).toBe(false);
    expect(isAgentTurnNoise('completed', undefined)).toBe(false);
  });

  test('topic ex-task (agente fermo): torna a essere una chat come le altre', () => {
    // È il bug opposto da evitare: sopprimere sulla sola esistenza del task
    // zittirebbe per sempre le chat umane in un topic già consegnato.
    for (const s of ['delivered', 'needs_input', 'waiting', 'exhausted']) {
      expect(isAgentTurnNoise('awaiting-user', s)).toBe(false);
      expect(isAgentTurnNoise('completed', s)).toBe(false);
    }
  });

  test('le fasi di lavoro non sono comunque bannerizzabili', () => {
    expect(isAgentTurnNoise('running', 'working')).toBe(false);
    expect(isAgentTurnNoise('tool-running', 'working')).toBe(false);
  });
});
