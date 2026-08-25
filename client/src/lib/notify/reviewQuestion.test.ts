/**
 * Whether a task in review is waiting on an answer or just on approval — read
 * from the payload when it carries the question, asked only when it cannot.
 *
 * @covers KANBAN-07
 */
import { describe, test, expect } from 'bun:test';
import { resolveReviewQuestion, type ReviewQuestionDeps } from './reviewQuestion';
import { buildNotifyActions } from '../../../../shared/notify-actions';

const FRAME = { projectId: 'proj-x', taskId: 't9' };

function deps(over?: Partial<ReviewQuestionDeps>) {
  const fetched: string[] = [];
  const inner = over?.fetchComments ?? (async () => []);
  const d: ReviewQuestionDeps = {
    delay: async () => { /* mai, se non chiesto */ },
    ...over,
    // Il contatore avvolge SEMPRE il finto, override compresi: senza, un test
    // che sostituisce `fetchComments` smette di misurare la cosa che verifica.
    fetchComments: (p, t) => { fetched.push(t); return inner(p, t); },
  };
  return { d, fetched };
}

function questionComment(text: string, options: string[]) {
  return { content: ['```question', text, ...options.map((o) => `- ${o}`), '```'].join('\n') };
}

describe('resolveReviewQuestion', () => {
  test('il fronte porta la domanda → nessuna richiesta al server', async () => {
    const { d, fetched } = deps();
    const q = { text: 'Lando?', options: ['Landa su main'] };
    expect(await resolveReviewQuestion({ ...FRAME, question: q }, d)).toEqual(q);
    expect(fetched).toEqual([]);
  });

  test('`null` è una risposta, non un vuoto: nessuna richiesta', async () => {
    const { d, fetched } = deps();
    expect(await resolveReviewQuestion({ ...FRAME, question: null }, d)).toBeNull();
    expect(fetched).toEqual([]);
  });

  test('campo ASSENTE (server vecchio) → si chiede il thread invece di indovinare', async () => {
    // È il caso che, dato per «nessuna domanda», metterebbe un tasto "Approva"
    // su un task che sta aspettando una risposta.
    const { d, fetched } = deps({
      fetchComments: async () => [
        { content: 'ho lavorato' },
        questionComment('Lando su main?', ['Landa su main', 'Aspetta']),
        { content: 'in_progress → review', kind: 'status' },
      ],
    });
    const resolved = await resolveReviewQuestion(FRAME, d);
    expect(resolved).toEqual({ text: 'Lando su main?', options: ['Landa su main', 'Aspetta'] });
    expect(fetched).toEqual(['t9']);
    expect(buildNotifyActions({ kind: 'review-ready', question: resolved as never }).map((a) => a.title))
      .toEqual(['Landa su main', 'Aspetta']);
  });

  test('server vecchio + consegna senza domanda → null (quindi «Approva»)', async () => {
    const { d } = deps({ fetchComments: async () => [{ content: 'Fatto, guarda il video.' }] });
    expect(await resolveReviewQuestion(FRAME, d)).toBeNull();
  });

  test("thread irraggiungibile → 'unknown': nessun tasto, mai uno indovinato", async () => {
    const { d } = deps({ fetchComments: async () => { throw new Error('offline'); } });
    expect(await resolveReviewQuestion(FRAME, d)).toBe('unknown');
    expect(buildNotifyActions({ kind: 'review-ready', question: { options: [] } })).toEqual([]);
  });

  test('server lento → si notifica lo stesso, senza tasti', async () => {
    // Il banner è un'interruzione: deve arrivare quando l'evento accade, non
    // quando il server si degna. Il ripiego ha un tetto.
    const { d } = deps({
      fetchComments: () => new Promise(() => { /* non risolve mai */ }),
      delay: async () => { /* il timeout scatta subito */ },
      timeoutMs: 1,
    });
    expect(await resolveReviewQuestion(FRAME, d)).toBe('unknown');
  });

  test('senza progetto o senza task non si chiede niente', async () => {
    const { d, fetched } = deps();
    expect(await resolveReviewQuestion({ taskId: 't9' }, d)).toBe('unknown');
    expect(await resolveReviewQuestion({ projectId: 'p' }, d)).toBe('unknown');
    expect(fetched).toEqual([]);
  });
});
