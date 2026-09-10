/**
 * The dispatch chip key of a delivery: a system move is not an agent delivery,
 * and a card with no branch, commit or file behind it is not a delivery at all.
 *
 * @covers KANBAN-07
 */
import { describe, expect, test } from 'bun:test';
import { chipKey, commentChip, commentChipTestId, taskHasWork, uncommittedChipCount } from './chipKey';
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
    expect(DISPATCH_CHIP.delivered_by_system!.textKey).not.toBe(DISPATCH_CHIP.delivered!.textKey);
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

  /**
   * THE NUMBER GOES IN THE CHIP, not in one more comment. "Branch with no
   * commit" says what is MISSING and stays silent on what is there: the same
   * words over a card that produced nothing and over one holding two finished
   * files in its worktree, which are the two opposite decisions.
   */
  test('il chip del ramo senza commit porta QUANTI file aspettano', () => {
    expect(uncommittedChipCount(2, true)).toBe(2);
    // A measured zero: nothing to save, so the chip keeps its old sentence.
    expect(uncommittedChipCount(0, true)).toBe(0);
    // NOT MEASURED IS NOT ZERO, but in the chip it reads the same: no number
    // gets invented, it just says what it has always said.
    expect(uncommittedChipCount(null, true)).toBe(0);
    expect(uncommittedChipCount(undefined, true)).toBe(0);
    // And outside the "branch with no commit" case the number is not shown at
    // all: on a measured delivery it would describe a worktree that is not it.
    expect(uncommittedChipCount(9, false)).toBe(0);
  });

  test('anche questa chiave esiste davvero, o la card resta MUTA', () => {
    expect(DISPATCH_CHIP.delivered_empty).toBeDefined();
  });
});

/**
 * WHAT THE BUBBLE SAYS ABOUT WORDS YOU JUST SENT, with two sources answering.
 *
 * The bug this closes was visible and durable: a steer typed on a card in
 * `todo` came back from the route as `note` — the route only resumes an agent
 * for `review`/`in_progress` — and the chip printed "Note saved. No agent
 * response requested." over words the person had just sent to the agent, while
 * the derivation for that same row said the card still owed a turn.
 */
describe('chip di un commento nel filo', () => {
  test('la derivazione batte una ricevuta che dice solo «non consegnato ora»', () => {
    expect(commentChip('pending', 'note')).toBe('pending');
    expect(commentChip('pending', 'saved')).toBe('pending');
    expect(commentChip('pending', undefined)).toBe('pending');
  });

  test('la busta e\' la prova, e sopravvive a ogni ricevuta', () => {
    expect(commentChip('delivered', 'note')).toBe('delivered');
    expect(commentChip('delivered', 'queued')).toBe('delivered');
  });

  test('la ricevuta parla dove la derivazione tace', () => {
    expect(commentChip(undefined, 'note')).toBe('note');
    expect(commentChip(undefined, 'saved')).toBe('saved');
    expect(commentChip(undefined, undefined)).toBeUndefined();
  });

  test('quello che la rotta ha appena fatto, e che nessuna busta mostra ancora', () => {
    // A routed question unblocked mid-turn: the card is still `in_progress`, so
    // the derivation says `pending`, but those words HAVE reached the agent.
    expect(commentChip('pending', 'answered')).toBe('answered');
    expect(commentChip('pending', 'queued')).toBe('queued');
  });

  test('il testid dice COSA c\'e\' scritto, non chi ha vinto', () => {
    expect(commentChipTestId('delivered')).toBe('task-comment-delivered');
    expect(commentChipTestId('answered')).toBe('task-comment-delivered');
    expect(commentChipTestId('pending')).toBe('task-comment-queued');
    expect(commentChipTestId('queued')).toBe('task-comment-queued');
    expect(commentChipTestId('note')).toBe('task-comment-receipt');
    expect(commentChipTestId('saved')).toBe('task-comment-receipt');
  });
});
