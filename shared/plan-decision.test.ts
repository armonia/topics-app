/**
 * La correzione al piano, letta da chi deve mandarla al modello.
 *
 * Sta accanto alla decisione perché viaggia sulla stessa risposta, ma su un
 * canale diverso: la decisione è in `answers`, la correzione in `metadata`. Se
 * finisse in `answers` la riga la ristamperebbe per esteso nel riassunto di
 * cosa hai scelto, cioè un piano intero in una riga sola.
 *
 * @covers PERM-09
 */
import { describe, expect, test } from 'bun:test';
import {
  editedPlanFrom,
  planDecisionFrom,
  PLAN_APPROVE_LABEL,
  PLAN_APPROVAL_QUESTION,
  PLAN_EDIT_KEY,
} from './plan-decision';

const approved = (metadata?: Record<string, unknown>) => ({
  kind: 'questions' as const,
  answers: { [PLAN_APPROVAL_QUESTION]: PLAN_APPROVE_LABEL },
  metadata,
});

describe('editedPlanFrom', () => {
  test('il piano corretto viaggia in metadata, non fra le risposte', () => {
    const response = approved({ [PLAN_EDIT_KEY]: '# Piano\n\n1. Primo passo corretto' });
    expect(editedPlanFrom(response)).toBe('# Piano\n\n1. Primo passo corretto');
    // La decisione resta leggibile come sempre, e le risposte restano corte.
    expect(planDecisionFrom(response)).toBe(true);
    expect(Object.values(response.answers).join(' ')).toBe(PLAN_APPROVE_LABEL);
  });

  test('un piano non toccato non è una correzione', () => {
    expect(editedPlanFrom(approved())).toBeNull();
    expect(editedPlanFrom(approved({}))).toBeNull();
  });

  test('una correzione vuota è nessuna correzione', () => {
    // Mandare un piano che non dice niente sostituirebbe la proposta col vuoto.
    expect(editedPlanFrom(approved({ [PLAN_EDIT_KEY]: '   \n ' }))).toBeNull();
  });

  test('un valore che non è testo si ignora invece di rompere', () => {
    expect(editedPlanFrom(approved({ [PLAN_EDIT_KEY]: 42 }))).toBeNull();
    expect(editedPlanFrom({ kind: 'raw' })).toBeNull();
  });
});
