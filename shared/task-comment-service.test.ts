/**
 * Which rows fold away, and which are speech.
 *
 * @covers THREAD-03, THREAD-05
 */
import { describe, expect, it } from 'bun:test';

import {
  FOLD_MIN_RUN,
  LEGACY_DISPATCHER_NOTES,
  SERVICE_KIND,
  foldsAway,
  groupServiceRuns,
  isLegacyDispatcherNote,
  isMarkedService,
  isServiceComment,
  type ThreadComment,
} from './task-comment-service';

function row(p: Partial<ThreadComment> = {}): ThreadComment {
  return {
    author: 'system',
    kind: 'comment',
    content: 'In coda: questo task e PESANTE',
    ...p,
  };
}

describe('isMarkedService', () => {
  it('folds a row the writer marked, whatever it says', () => {
    // The point of the mark: rewording the note must not bring the row back.
    expect(isMarkedService(row({ kind: SERVICE_KIND, content: 'anything at all' }))).toBe(true);
  });

  it('does not fold an unmarked row', () => {
    expect(isMarkedService(row({ kind: 'comment' }))).toBe(false);
    expect(isMarkedService(row({ kind: 'status' }))).toBe(false);
    expect(isMarkedService(row({ kind: 'review-note' }))).toBe(false);
  });
});

describe('isLegacyDispatcherNote', () => {
  it('reads the old bookkeeping rows that no migration will ever mark', () => {
    for (const content of [
      'Riavvio del server: ripreso in diretta il turno',
      "Attenzione: c'e' una sessione Claude esterna viva su questo repo",
      'In coda: questo task e PESANTE',
      "Turno concluso dall'agente senza portare il task in review: l'agent continua sulla stessa sessione (tentativo 2/3).",
      'Errore del provider: riprovo tra 30s sulla stessa sessione (tentativo 2/3, non conteggiato).',
      "L'agent ha lavorato 3 turni ma non ha spostato il task in review da solo. L'ho portato io in review.",
    ]) {
      expect(isLegacyDispatcherNote(row({ content }))).toBe(true);
    }
  });

  it('only ever looks at rows the machine wrote', () => {
    const content = 'In coda: questo task e PESANTE';
    // A human quoting the dispatcher is still a human talking.
    expect(isLegacyDispatcherNote(row({ content, author: 'user' }))).toBe(false);
    expect(isLegacyDispatcherNote(row({ content, author: 'agent:abc' }))).toBe(false);
    // Transition history and review evidence each have their own row to be.
    expect(isLegacyDispatcherNote(row({ content, kind: 'status' }))).toBe(false);
    expect(isLegacyDispatcherNote(row({ content, kind: 'review-note' }))).toBe(false);
  });

  it('leaves a machine note nobody recognises on screen', () => {
    // The failure mode of a miss is one extra line, never a hidden one.
    expect(isLegacyDispatcherNote(row({ content: 'Qualcosa di nuovo che nessuno ha previsto' }))).toBe(false);
  });

  it('keeps outcomes and decisions visible', () => {
    // 'system' is an author, not a sender: these are the rows whose ONLY
    // surface is the thread, and a fold keyed on the author would eat them.
    for (const content of [
      'Land NON riuscito: conflitto su shared/board.ts',
      'Landato su main ma NON ancora attivo',
      'Consegnato ma NON su main',
      'Checks pre-review: 2 rossi',
      'Pubblicato su origin/main',
      'Fan-out chiuso: scegli fra i 3 tentativi',
      'Client ricostruito',
      // The two DECISIONS whose first words are the dispatcher's own turn-end
      // phrases. Matching those phrases as a prefix would fold the only line
      // that says why a card is parked in backlog: 344 + 245 rows on the live
      // database open with them, and 3 of those are this note.
      "Turno concluso dall'agente senza portare il task in review. Nessun output dopo 2 tentativi: parcheggiato in backlog.",
      'Turno tagliato dal limite di tempo. Nessun output dopo 2 tentativi: parcheggiato in backlog.',
    ]) {
      expect(isLegacyDispatcherNote(row({ content }))).toBe(false);
    }
  });

  it("NEVER folds the delivery note that carries the agent's recovered words", () => {
    // When the agent's turn ends without a comment, the dispatcher delivers to
    // review with the agent's words recovered from the session appended after a
    // blank line. 198 such rows on the live database, 128 of them carrying
    // those words: they are the only thing the agent said on that card, and
    // folding them buries the very speech this whole file exists to surface.
    const bookkeepingOnly =
      "L'agent ha lavorato 3 turni ma non ha spostato il task in review da solo. L'ho portato io in review.";
    expect(isLegacyDispatcherNote(row({ content: bookkeepingOnly }))).toBe(true);
    expect(isLegacyDispatcherNote(row({
      content: `${bookkeepingOnly}\n\nUltime parole dell'agent (recuperate dalla sessione): ho finito il refactor, i test passano.`,
    }))).toBe(false);
  });

  it('anchors every wording, at the start of the row or at its end', () => {
    // Anchored patterns only: a quote of the note buried mid-sentence in a
    // human's message must not drag that message into the fold.
    for (const re of LEGACY_DISPATCHER_NOTES) {
      expect(re.source.startsWith('^') || re.source.endsWith('$')).toBe(true);
    }
  });
});

describe('isServiceComment', () => {
  it('takes either rule', () => {
    expect(isServiceComment(row({ kind: SERVICE_KIND, content: 'reworded' }))).toBe(true);
    expect(isServiceComment(row())).toBe(true);
    expect(isServiceComment(row({ author: 'agent:abc', kind: 'comment', content: 'ho finito' }))).toBe(false);
  });

  it('NO TIME BOMB: the same row reads the same whenever it was written', () => {
    // An earlier draft fenced the wording rule behind "written before the mark
    // shipped", with the instant hard-coded to the day the branch was written.
    // Every dispatcher note written between that instant and the deploy - 500
    // to 800 a day, measured - was then neither marked nor recognisable, and no
    // migration goes back for them. The classifier cannot see a clock any more:
    // `ThreadComment` does not carry `createdAt`, so this property is
    // structural, and this test is the tripwire on anyone adding it back.
    const sample = row({ content: 'In coda: questo task e PESANTE' });
    expect(Object.keys(sample)).not.toContain('createdAt');
    // Passing a date alongside changes nothing: it is not read.
    expect(isServiceComment({ ...sample, createdAt: '2020-01-01T00:00:00.000Z' } as ThreadComment)).toBe(true);
    expect(isServiceComment({ ...sample, createdAt: '2099-01-01T00:00:00.000Z' } as ThreadComment)).toBe(true);
  });
});

describe('groupServiceRuns', () => {
  const service = (n: string) => row({ content: `In coda: ${n}` });
  const speech = (n: string) => row({ author: 'agent:abc', content: n });

  it('drops nothing: the runs concatenate back to the input', () => {
    const thread = [speech('a'), service('1'), service('2'), speech('b'), service('3')];
    const runs = groupServiceRuns(thread);
    expect(runs.flatMap((r) => r.comments)).toEqual(thread);
  });

  it('groups adjacent rows so the fold stays where it happened', () => {
    const runs = groupServiceRuns([speech('a'), service('1'), service('2'), speech('b')]);
    expect(runs.map((r) => [r.service, r.comments.length])).toEqual([
      [false, 1],
      [true, 2],
      [false, 1],
    ]);
  });

  it('cuts a run where the caller says the agent spoke', () => {
    // The thread interleaves session steps between comments. A wall that
    // swallowed those would hide the speech this whole thing exists to surface.
    const thread = [service('1'), service('2'), service('3')];
    const runs = groupServiceRuns(thread, (_c, i) => i === 2);
    expect(runs.map((r) => r.comments.length)).toEqual([2, 1]);
    expect(runs.every((r) => r.service)).toBe(true);
    expect(runs.flatMap((r) => r.comments)).toEqual(thread);
  });

  it('never cuts before the first row', () => {
    const runs = groupServiceRuns([service('1'), service('2')], () => true);
    expect(runs.map((r) => r.comments.length)).toEqual([1, 1]);
  });

  it('returns nothing for an empty thread', () => {
    expect(groupServiceRuns([])).toEqual([]);
  });
});

describe('foldsAway', () => {
  it('folds a wall of bookkeeping', () => {
    expect(foldsAway({ service: true, comments: new Array(FOLD_MIN_RUN).fill(0) })).toBe(true);
    expect(foldsAway({ service: true, comments: new Array(20).fill(0) })).toBe(true);
  });

  it('leaves a lone service note alone', () => {
    // "1 riga di servizio" hides a message without compacting anything.
    expect(foldsAway({ service: true, comments: [0] })).toBe(false);
  });

  it('never folds speech', () => {
    expect(foldsAway({ service: false, comments: [0, 1, 2] })).toBe(false);
  });
});
