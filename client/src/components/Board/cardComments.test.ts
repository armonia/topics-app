import { describe, test, expect } from 'bun:test';
import { selectCardComments, isHumanComment } from './cardComments';
import { NOTE_ARCHIVED_BY_HUMAN, NOTE_STOPPED_BY_HUMAN, noteParkedChildrenResolved } from '../../../../shared/board';
import type { TaskComment } from '../../lib/board';

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
    const human = comment('user', 'rifai l header');
    const evidence = comment('system', 'Anteprima viva pronta: http://127.0.0.1:5173', 'review-note');
    const got = selectCardComments([human, evidence]);
    expect(got?.latest).toBe(evidence);
    expect(got?.humanContext).toBeNull();
  });

  test('an agent replied and evidence followed: the pair holds, evidence leads', () => {
    const human = comment('user', 'rifai l header');
    const agent = comment('claude', 'rifatto');
    const evidence = comment('system', 'Anteprima viva pronta: http://127.0.0.1:5173', 'review-note');
    const got = selectCardComments([human, agent, evidence]);
    expect(got?.latest).toBe(evidence);
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
