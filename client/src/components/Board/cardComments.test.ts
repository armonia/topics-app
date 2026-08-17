import { describe, test, expect } from 'bun:test';
import { cardCommentsFromRow, cardDetailNeed, selectCardComments, isHumanComment, showsCardThread, type CardThreadRow } from './cardComments';
import { NOTE_ARCHIVED_BY_HUMAN, NOTE_STOPPED_BY_HUMAN, noteParkedChildrenResolved } from '../../../../shared/board';
import type { CardComment, TaskComment } from '../../lib/board';

/**
 * The card kept only the thread's last word, and on a task that had already
 * bounced through review that word is always the agent's. The human read the
 * answer with his own request gone, and had to remember it.
 *
 * Every fixture here is built so that the guard it targets can actually fire.
 * A thread of two entries never reaches the backward scan, so it proves nothing
 * about which request the scan picks: the "human spoke last" cases carry an
 * OLDER human request behind them, which is the only shape where dropping the
 * guard changes the answer.
 */

let seq = 0;
function comment(author: string, content: string, kind: TaskComment['kind'] = 'comment'): TaskComment {
  seq += 1;
  return {
    id: `c${seq}`,
    taskId: 't1',
    author,
    content,
    mentions: [],
    media: [],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    kind,
  };
}

describe('selectCardComments', () => {
  test('no human in the thread: the agent alone, exactly like before', () => {
    const agent = comment('claude', 'delivered, ready for review');
    const got = selectCardComments([agent]);
    expect(got?.latest).toBe(agent);
    // Not a placeholder, not an empty line: nothing at all.
    expect(got?.humanContext).toBeNull();
  });

  test('human then agent: the pair, request above and answer as the protagonist', () => {
    const human = comment('user', 'the button is still misaligned');
    const agent = comment('topic-one', 'fixed, it now snaps to the grid');
    const got = selectCardComments([human, agent]);
    expect(got?.latest).toBe(agent);
    expect(got?.humanContext).toBe(human);
  });

  test('the human is the last word: he is the protagonist and is not repeated', () => {
    // An OLDER request sits behind him. Without the "human spoke last" guard
    // the backward scan finds it and the card prints the request he already
    // replaced, above the one he just typed.
    const old = comment('user', 'first round of notes');
    const answer = comment('claude', 'first answer');
    const human = comment('user', 'redo it, the gate is red');
    const got = selectCardComments([old, answer, human]);
    expect(got?.latest).toBe(human);
    expect(got?.humanContext).toBeNull();
  });

  test('two rounds: the context is the LAST request, not the first one', () => {
    const first = comment('user', 'first round of notes');
    const answered = comment('claude', 'first answer');
    const second = comment('user', 'second round of notes');
    const got = selectCardComments([first, answered, second, comment('claude', 'second answer')]);
    expect(got?.humanContext).toBe(second);
  });

  test('system only: nothing is passed off as a human request', () => {
    const note = comment('system', 'Merged into main (commit abc1234).');
    const got = selectCardComments([note]);
    expect(got?.latest).toBe(note);
    expect(got?.humanContext).toBeNull();
  });

  test('status rows are history: they are never the last word nor the context', () => {
    const request = comment('user', 'redo the header');
    const agent = comment('claude', 'delivered');
    const moved = comment('user', 'in_progress→review', 'status');
    const got = selectCardComments([request, agent, moved]);
    expect(got?.latest).toBe(agent);
    expect(got?.humanContext).toBe(request);
  });

  test('a review note between the two does not break the pair', () => {
    const human = comment('user', 'attach the screenshot');
    const evidence = comment('system', 'Anteprima', 'review-note');
    const agent = comment('claude', 'attached');
    const got = selectCardComments([human, evidence, agent]);
    expect(got?.latest).toBe(agent);
    expect(got?.humanContext).toBe(human);
  });

  test('only machine evidence answered: no pair, because nothing replied', () => {
    // The preview manager writes its note the moment the task enters review.
    // With no agent word after the request, the card would read as a question
    // answered by a URL.
    //
    // Dal 17/08 in cima va la RICHIESTA UMANA, non la nota: nessuno ha
    // risposto, quindi l'ultima parola vera e' ancora la sua. `humanContext`
    // resta nullo perche' una coppia «domanda / risposta» qui non c'e'.
    const human = comment('user', 'rifai l header');
    const evidence = comment('system', 'Anteprima viva pronta: http://127.0.0.1:5173', 'review-note');
    const got = selectCardComments([human, evidence]);
    expect(got?.latest).toBe(human);
    expect(got?.humanContext).toBeNull();
  });

  test("an agent replied and evidence followed: the pair holds, and the AGENT leads", () => {
    // REGOLA CAMBIATA IL 17/08, e il perche' e' una misura.
    //
    // Prima guidava l'evidenza (b293208b, 13/08): allora la `review-note`
    // portava un link all'anteprima viva, cioe' qualcosa da APRIRE. Oggi
    // l'anteprima e' un'immagine sulla card, quindi quella riga e' un
    // promemoria che si ripete a ogni ingresso in review - misurato: 19 card
    // su 22 mostravano «Consegna SENZA anteprima…» o «Anteprima viva pronta»
    // al posto del riassunto della consegna. Segnalato: «gli ultimi commenti
    // che devo da review non hanno senso, saranno messaggi di sistema».
    //
    // La nota resta nel thread e resta l'ultima parola quando e' l'UNICA
    // (test qui sotto): non si butta, si toglie di mezzo quando c'e' qualcuno
    // che ha parlato davvero.
    const human = comment('user', 'rifai l header');
    const agent = comment('claude', 'rifatto');
    const evidence = comment('system', 'Anteprima viva pronta: http://127.0.0.1:5173', 'review-note');
    const got = selectCardComments([human, agent, evidence]);
    expect(got?.latest).toBe(agent);
    expect(got?.humanContext).toBe(human);
  });

  test('a human comment with no text opens no row: the card falls back to the older request', () => {
    const request = comment('user', 'redo the header');
    const answer = comment('claude', 'redone');
    const attachmentOnly = comment('user', '   ');
    const got = selectCardComments([request, answer, attachmentOnly, comment('claude', 'and again')]);
    expect(got?.humanContext).toBe(request);
    // Blank and alone it stays out entirely, rather than drawing an empty line.
    expect(selectCardComments([attachmentOnly, comment('claude', 'ok')])?.humanContext).toBeNull();
  });

  test('an empty thread has no card comments at all', () => {
    expect(selectCardComments([])).toBeNull();
    expect(selectCardComments([comment('user', 'todo→in_progress', 'status')])).toBeNull();
  });

  /**
   * Stop and "archive with a live agent" both call `release({ by: 'user' })`,
   * which drops the reason into the thread signed `user`. The normal loop is
   * Stop, back to Todo, the agent delivers: without the machine-note filter the
   * next review card quotes the server's own sentence as your request.
   */
  test.each([
    ['stop', NOTE_STOPPED_BY_HUMAN],
    ['archive with a live agent', NOTE_ARCHIVED_BY_HUMAN],
    ['parked children requeued', noteParkedChildrenResolved('requeue', 3)],
    ['parked children archived', noteParkedChildrenResolved('archive', 1)],
  ])('a machine note signed user is not your request (%s)', (_case, note) => {
    const machine = comment('user', note);
    const got = selectCardComments([machine, comment('claude', 'Fatto.')]);
    expect(got?.humanContext).toBeNull();
    // And it is not promoted to protagonist either when it is the last word.
    expect(selectCardComments([comment('claude', 'delivered'), machine])?.humanContext).toBeNull();
  });

  test('a machine note does not hide the real request behind it', () => {
    const request = comment('user', 'rifai la testata');
    const stopped = comment('user', NOTE_STOPPED_BY_HUMAN);
    const agent = comment('claude', 'rifatta');
    const got = selectCardComments([request, stopped, agent]);
    expect(got?.humanContext).toBe(request);
  });

  /**
   * The dispatcher's bookkeeping is not the delivery.
   *
   * A queue hold or a restart note (kind 'service') lands whenever the
   * dispatcher feels like saying something, which on a card in review is often
   * AFTER the agent has answered. Reading it as the thread's last word makes
   * the card quote "In attesa di uno slot" as the delivery - and worse, the
   * quick-reply buttons underneath come from `pendingQuestion`, which already
   * skips those rows: the card would offer two answers to a question whose text
   * it is not showing. Same predicate on both, or the card contradicts itself.
   */
  test('a service note after the answer is not the delivery', () => {
    const request = comment('user', 'aggiusta il bottone');
    const agent = comment('claude', 'fatto, ora si allinea');
    const hold = comment('system', 'In attesa di uno slot: il tetto di concorrenza e\' pieno.', 'service');
    const got = selectCardComments([request, agent, hold]);
    expect(got?.latest).toBe(agent);
    expect(got?.humanContext).toBe(request);
  });

  test('a service note does not hide the human request behind it either', () => {
    const request = comment('user', 'rifai la testata');
    const hold = comment('system', 'In coda: questo task e\' PESANTE.', 'service');
    const agent = comment('claude', 'rifatta');
    expect(selectCardComments([request, hold, agent])?.humanContext).toBe(request);
  });
});

/**
 * UNA RICHIESTA PER CARD, E OGNUNA CARICAVA UN THREAD INTERO.
 *
 * Aprendo la board, ogni scheda in review sparava un `GET /api/tasks/:id` solo
 * per leggere il fondo del suo thread — e quel dettaglio non porta tre righe,
 * porta tutto il thread più i figli. Adesso i commenti viaggiano con la lista
 * (`task.recentComments`, misurato: 731 KB attaccati a 455 schede su 467 perché
 * ne leggessero 11) e resta un solo motivo per chiedere: i sottotask, che nel
 * feed non ci sono.
 *
 * La decisione vive qui e non dentro `Card.tsx` proprio perché QUESTO si può
 * eseguire: la card importa `@/lib/popoverStyles`, un alias che `bun test` non
 * risolve, quindi montarla non è possibile (stessa nota in `Card.test.ts`).
 */
function row(patch: Partial<CardThreadRow> = {}): CardThreadRow {
  return {
    status: 'review',
    assignedTopicId: 'topic-1',
    deliveredReason: null,
    subtaskCount: 0,
    recentComments: [],
    ...patch,
  };
}

const speech = (author: string, content: string, kind: CardComment['kind'] = 'comment'): CardComment =>
  ({ author, content, kind });

describe('cardDetailNeed: quando la card deve ancora chiedere', () => {
  test('la lista porta i commenti: nessuna richiesta', () => {
    expect(cardDetailNeed(row({ recentComments: [speech('claude', 'consegnato')] }))).toBe('none');
    // Anche quando non c'è niente da dire: `[]` è una risposta, non un vuoto da
    // riempire con una GET.
    expect(cardDetailNeed(row({ recentComments: [] }))).toBe('none');
  });

  test('fuori dalla review non si chiede niente, qualunque cosa ci sia sulla riga', () => {
    for (const status of ['backlog', 'todo', 'in_progress', 'done'] as const) {
      expect(cardDetailNeed(row({ status, subtaskCount: 3, recentComments: undefined })), status).toBe('none');
    }
  });

  test('i sottotask restano l\'unico motivo per aprire il dettaglio', () => {
    // I figli non viaggiano nel feed (`rootsOnly`), e la card in review li
    // espande come checklist della consegna.
    expect(cardDetailNeed(row({ subtaskCount: 2 }))).toBe('children');
    // Senza figli non si chiede: era questa la GET moltiplicata per ogni card.
    expect(cardDetailNeed(row({ subtaskCount: 0 }))).toBe('none');
  });

  test('un server più vecchio del client fa tornare la card a chiedere', () => {
    // Il guscio Tauri incorpora il suo `public/` e può parlare con un server
    // che `recentComments` non lo manda: senza questa ricaduta la scheda in
    // review resterebbe muta invece di pagare una richiesta.
    expect(cardDetailNeed(row({ recentComments: undefined }))).toBe('thread');
    // E la domanda del SISTEMA (figli parcheggiati) è l'altro ramo che mostra
    // il thread pur senza topic dell'agente.
    expect(cardDetailNeed(row({ assignedTopicId: null, deliveredReason: 'parked_children', recentComments: undefined })))
      .toBe('thread');
    // Una review senza né agente né domanda di sistema non mostra parole: non
    // chiede nemmeno con il server vecchio.
    expect(cardDetailNeed(row({ assignedTopicId: null, recentComments: undefined }))).toBe('none');
  });
});

describe('showsCardThread / cardCommentsFromRow', () => {
  test('la coppia si costruisce dalla riga, senza rete', () => {
    const got = cardCommentsFromRow(row({
      recentComments: [speech('user', 'rifai la testata'), speech('claude', 'rifatta')],
    }));
    expect(got?.latest.content).toBe('rifatta');
    expect(got?.humanContext?.content).toBe('rifai la testata');
  });

  test('le stesse tre righe su una card che non li disegna non danno niente', () => {
    // Il predicato è lo stesso che il server usa per decidere a chi attaccarli:
    // se qui si allargasse, la card leggerebbe un campo che nessuno riempie.
    expect(showsCardThread(row({ status: 'done' }))).toBe(false);
    expect(cardCommentsFromRow(row({ status: 'done', recentComments: [speech('claude', 'fatto')] }))).toBeNull();
    expect(cardCommentsFromRow(row({ recentComments: undefined }))).toBeNull();
  });
});

describe('isHumanComment', () => {
  test('only author user with kind comment counts as the human word', () => {
    expect(isHumanComment(comment('user', 'redo it'))).toBe(true);
    expect(isHumanComment(comment('claude', 'done'))).toBe(false);
    expect(isHumanComment(comment('system', 'Merged into main.'))).toBe(false);
    expect(isHumanComment(comment('user', 'todo→review', 'status'))).toBe(false);
    expect(isHumanComment(comment('user', 'Anteprima', 'review-note'))).toBe(false);
  });

  test('the server writing under the human signature is not the human', () => {
    expect(isHumanComment(comment('user', NOTE_STOPPED_BY_HUMAN))).toBe(false);
    expect(isHumanComment(comment('user', NOTE_ARCHIVED_BY_HUMAN))).toBe(false);
    expect(isHumanComment(comment('user', noteParkedChildrenResolved('archive', 2)))).toBe(false);
  });
});
