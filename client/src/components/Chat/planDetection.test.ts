import { describe, expect, test } from 'bun:test';
import { findPendingPlan, isPlanResponse } from './planDetection';
import type { ChatMessage, ToolCall } from '../../types';
import { PLAN_APPROVAL_QUESTION, PLAN_APPROVE_LABEL } from '../../../../shared/plan-decision';

/**
 * Il cancello del piano, letto da chi deve mostrarlo.
 *
 * Due forme, una decisione: il BLOCCO (il piano scritto in `~/.claude/plans/`,
 * che il server mette in attesa con lo schema di approvazione) e la PROSA (il
 * piano scritto e basta, senza nessuna riga a cui appendere la domanda). Qui si
 * fissa quale delle due vince, e soprattutto quando NON si chiede niente.
 *
 * @covers CHAT-02
 */

// Il formato che l'app stessa ordina in plan mode (`planModeContent()`).
const PROSA = '## Plan\n\n1. **Primo** — leggere\n2. **Secondo** — scrivere\n\n## Summary\nbreve.';

function assistant(content: string, tools: ToolCall[] = []): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: '2026-08-10T10:00:00.000Z',
    toolCalls: tools,
    blocks: tools.map((toolCall) => ({ kind: 'tool' as const, toolCall })),
  };
}

const planoInAttesa: ToolCall = {
  id: 'toolu_plan',
  name: 'Write',
  args: { file_path: '/Users/x/.claude/plans/roba.md', content: PROSA },
  status: 'waiting_for_input',
  userInputSchema: {
    kind: 'questions',
    questions: [{
      question: PLAN_APPROVAL_QUESTION,
      header: 'Piano',
      options: [{ label: PLAN_APPROVE_LABEL }, { label: 'Rifiuta e riprova' }],
    }],
  },
};

const domandaQualunque: ToolCall = {
  id: 'toolu_ask',
  name: 'AskUserQuestion',
  args: {},
  status: 'waiting_for_input',
  userInputSchema: {
    kind: 'questions',
    questions: [{ question: 'Quale strada?', header: 'Strada', options: [{ label: 'A' }, { label: 'B' }] }],
  },
};

describe('findPendingPlan — il blocco strutturato viene prima', () => {
  test('un piano in attesa è la riga a cui rispondere', () => {
    const found = findPendingPlan({ messages: [assistant('', [planoInAttesa])], autonomy: 'ask' });
    expect(found).toEqual({ toolCallId: 'toolu_plan' });
  });

  test('il blocco vale anche fuori da plan mode: la domanda è già posta', () => {
    // Se il turno l'ha CHIESTO, la chiediamo. L'autonomia gata solo il ripiego
    // a fiuto, che una domanda vera non è.
    const found = findPendingPlan({ messages: [assistant('', [planoInAttesa])], autonomy: 'auto-apply' });
    expect(found?.toolCallId).toBe('toolu_plan');
  });

  test('un ask qualunque aperto NON è un piano, e blocca il ripiego', () => {
    // Due pannelli che aspettano risposte diverse sono il modo di rispondere
    // alla cosa sbagliata: qui la palla è dell'ask, e la barra tace.
    expect(findPendingPlan({ messages: [assistant(PROSA, [domandaQualunque])], autonomy: 'ask' })).toBeNull();
  });
});

describe('findPendingPlan — il ripiego sulla prosa', () => {
  test('in plan mode un piano scritto in prosa è comunque una domanda', () => {
    expect(findPendingPlan({ messages: [assistant(PROSA)], autonomy: 'ask' })).toEqual({ toolCallId: null });
  });

  test('fuori da plan mode un piano scritto è una nota di lavoro, non una domanda', () => {
    expect(findPendingPlan({ messages: [assistant(PROSA)], autonomy: 'auto-apply' })).toBeNull();
    expect(findPendingPlan({ messages: [assistant(PROSA)], autonomy: null })).toBeNull();
  });

  test('mentre il turno scrive non ha ancora proposto niente', () => {
    expect(findPendingPlan({ messages: [assistant(PROSA)], autonomy: 'ask', busy: true })).toBeNull();
  });

  test('una decisione già presa su questo turno non si richiede', () => {
    const deciso: ToolCall = {
      ...planoInAttesa,
      status: 'success',
      userInputSchema: undefined,
      userResponse: {
        kind: 'questions',
        answers: { [PLAN_APPROVAL_QUESTION]: PLAN_APPROVE_LABEL },
        submittedAt: '2026-08-10T10:01:00.000Z',
      },
    };
    expect(findPendingPlan({ messages: [assistant(PROSA, [deciso])], autonomy: 'ask' })).toBeNull();
  });

  test('prosa che non è un piano, ultimo messaggio dell’umano, o niente messaggi', () => {
    expect(findPendingPlan({ messages: [assistant('faccio così e poi vediamo')], autonomy: 'ask' })).toBeNull();
    expect(findPendingPlan({
      messages: [assistant(PROSA), { id: 'u', role: 'user', content: 'ok', timestamp: '2026-08-10T10:02:00.000Z' }],
      autonomy: 'ask',
    })).toBeNull();
    expect(findPendingPlan({ messages: [], autonomy: 'ask' })).toBeNull();
    expect(findPendingPlan({ messages: undefined, autonomy: 'ask' })).toBeNull();
  });
});

describe('isPlanResponse', () => {
  test('il formato ordinato in plan mode si riconosce', () => {
    expect(isPlanResponse(PROSA)).toBe(true);
    expect(isPlanResponse('## Implementation Plan\n\n1. uno\n2. due')).toBe(true);
  });

  test('un titolo senza passi, o passi senza titolo, non bastano', () => {
    expect(isPlanResponse('## Plan\n\nfaccio due cose e finisco')).toBe(false);
    expect(isPlanResponse('1. uno\n2. due')).toBe(false);
    expect(isPlanResponse('')).toBe(false);
  });
});
