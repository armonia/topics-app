/**
 * @covers ASK-08
 */
import { describe, expect, test } from 'bun:test';
import { answerFromText, findPendingAsk, type PendingAsk } from './pendingAsk';
import type { ChatMessage, ToolCall } from '../types';

function assistant(tools: ToolCall[], extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${tools.map((t) => t.id).join('-') || 'empty'}`,
    role: 'assistant',
    content: '',
    timestamp: '2026-08-03T20:00:00.000Z',
    toolCalls: tools,
    blocks: tools.map((toolCall) => ({ kind: 'tool' as const, toolCall })),
    ...extra,
  };
}

const asking: ToolCall = {
  id: 'toolu_ask',
  name: 'mcp__topics__ask_user_question',
  args: {},
  status: 'waiting_for_input',
  userInputSchema: {
    kind: 'questions',
    questions: [{ question: 'Quale strada?', header: 'Strada', options: [{ label: 'A' }, { label: 'B' }] }],
  },
};

describe('findPendingAsk', () => {
  test('trova la domanda aperta sull’ultimo messaggio assistant', () => {
    const found = findPendingAsk([assistant([asking])]);
    expect(found?.toolCallId).toBe('toolu_ask');
    expect(found?.toolName).toBe('mcp__topics__ask_user_question');
  });

  test('ignora un waiting_for_input rimasto appeso in un turno PRECEDENTE', () => {
    // È il fantasma di uno stream perso: il processo dall'altra parte non c'è
    // più, e mandargli una risposta la farebbe sparire nel nulla.
    const msgs = [
      assistant([asking]),
      { id: 'u1', role: 'user' as const, content: 'altro', timestamp: '2026-08-03T20:01:00.000Z' },
      assistant([{ ...asking, id: 'toolu_done', status: 'success' }]),
    ];
    expect(findPendingAsk(msgs)).toBeNull();
  });

  test('senza schema non è una domanda rispondibile', () => {
    expect(findPendingAsk([assistant([{ ...asking, userInputSchema: undefined }])])).toBeNull();
  });

  test('legge anche il vecchio secchio toolCalls, senza timeline blocks', () => {
    const msg = assistant([asking]);
    expect(findPendingAsk([{ ...msg, blocks: undefined }])?.toolCallId).toBe('toolu_ask');
  });

  test('niente messaggi, o ultimo messaggio dell’umano ⇒ nessuna domanda', () => {
    expect(findPendingAsk([])).toBeNull();
    expect(findPendingAsk(undefined)).toBeNull();
    expect(
      findPendingAsk([{ id: 'u', role: 'user', content: 'ciao', timestamp: '2026-08-03T20:00:00.000Z' }]),
    ).toBeNull();
  });
});

describe('answerFromText', () => {
  const oneQuestion: PendingAsk = {
    toolCallId: 't',
    toolName: 'ask',
    schema: {
      kind: 'questions',
      questions: [{ question: 'Quale strada?', header: 'S', options: [{ label: 'A' }] }],
    },
  };

  test('una sola domanda ⇒ il testo è la risposta, verbatim', () => {
    const r = answerFromText(oneQuestion, '  il secondo, quello dei bug  ');
    expect(r).toEqual({
      kind: 'questions',
      answers: { 'Quale strada?': 'il secondo, quello dei bug' },
      submittedAt: expect.any(String),
    });
  });

  test('non prova ad agganciare il testo a un’opzione', () => {
    // Rispondere «A» quando l'umano ha scritto «boh, la prima» sarebbe un
    // indovinello: chi interpreta la prosa è il modello, non questa funzione.
    const r = answerFromText(oneQuestion, 'boh, la prima');
    expect(r).toMatchObject({ answers: { 'Quale strada?': 'boh, la prima' } });
  });

  test('testo vuoto non è una risposta', () => {
    expect(answerFromText(oneQuestion, '   ')).toBeNull();
  });

  test('più domande ⇒ resta il pannello', () => {
    const multi: PendingAsk = {
      toolCallId: 't',
      toolName: 'ask',
      schema: {
        kind: 'questions',
        questions: [
          { question: 'Prima?', header: 'A', options: [{ label: 'x' }] },
          { question: 'Seconda?', header: 'B', options: [{ label: 'y' }] },
        ],
      },
    };
    expect(answerFromText(multi, 'sì')).toBeNull();
  });

  test('elicitation ⇒ resta il pannello, la prosa non riempie uno schema JSON', () => {
    const elicit: PendingAsk = {
      toolCallId: 't',
      toolName: 'ask',
      schema: { kind: 'elicitation', requestedSchema: { type: 'object' } },
    };
    expect(answerFromText(elicit, 'qualcosa')).toBeNull();
  });

  test('raw ⇒ il testo passa così com’è', () => {
    const raw: PendingAsk = { toolCallId: 't', toolName: 'ask', schema: { kind: 'raw', rawInput: null } };
    expect(answerFromText(raw, 'ciao')).toMatchObject({ kind: 'raw', text: 'ciao' });
  });
});

describe('la scelta su un piano non si risponde scrivendo', () => {
  // Fra due opzioni esatte, «vai» o «no direi» sono un indovinello — e
  // indovinare male esegue un piano che volevi rifiutare. Il gesto è il
  // bottone; il composer non deve promettere il contrario.
  const planAsk: PendingAsk = {
    toolCallId: 'toolu_plan',
    toolName: 'Write',
    schema: {
      kind: 'questions',
      questions: [{
        question: 'Approvo questo piano?',
        header: 'Piano',
        options: [{ label: 'Approva ed esegui' }, { label: 'Rifiuta e riprova' }],
      }],
    },
  };

  test('answerFromText si tira indietro', () => {
    expect(answerFromText(planAsk, 'sì vai')).toBeNull();
    expect(answerFromText(planAsk, 'Approva ed esegui')).toBeNull();
  });

  test('una domanda normale a una voce resta rispondibile a parole', () => {
    const normale: PendingAsk = {
      toolCallId: 't', toolName: 'x',
      schema: { kind: 'questions', questions: [{ question: 'Quale runtime?', header: 'R', options: [{ label: 'Bun' }] }] },
    };
    expect(answerFromText(normale, 'Bun')).not.toBeNull();
  });
});
