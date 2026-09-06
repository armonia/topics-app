/**
 * The correction to the plan, read by whoever has to send it to the model.
 *
 * It sits next to the decision because it travels on the same response, but on
 * a different channel: the decision is in `answers`, the correction in
 * `metadata`. In `answers` the tool row would reprint it in full in the summary
 * of what you picked, which means a whole plan on a single line.
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
    // The decision stays as readable as ever, and the answers stay short.
    expect(planDecisionFrom(response)).toBe(true);
    expect(Object.values(response.answers).join(' ')).toBe(PLAN_APPROVE_LABEL);
  });

  test('un piano non toccato non è una correzione', () => {
    expect(editedPlanFrom(approved())).toBeNull();
    expect(editedPlanFrom(approved({}))).toBeNull();
  });

  test('una correzione vuota è nessuna correzione', () => {
    // Sending a plan that says nothing would replace the proposal with emptiness.
    expect(editedPlanFrom(approved({ [PLAN_EDIT_KEY]: '   \n ' }))).toBeNull();
  });

  test('un valore che non è testo si ignora invece di rompere', () => {
    expect(editedPlanFrom(approved({ [PLAN_EDIT_KEY]: 42 }))).toBeNull();
    expect(editedPlanFrom({ kind: 'raw' })).toBeNull();
  });
});
