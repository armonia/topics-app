/**
 * Which actions a card offers, and with which words: review (land / approve /
 * send back), a live turn (stop / deliver what you have), a blocked task.
 *
 * @covers KANBAN-05, KANBAN-07
 */
import { describe, it, expect } from 'bun:test';
import { taskChoices, taskChoiceState, usableQuestionOptions, type TaskChoiceId } from './taskChoices';
import { acceptWord, drawerSurfaceLabels, redoWord, reviewDecisionButtons, sendBackWord, stopWord, taskActionWord, unblockWord } from './taskActionWords';
import { ensureLocaleLoaded } from '../../lib/i18n';
import { buildNotifyActions } from '../../../../shared/notify-actions';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// L'inglese vive in un chunk suo (`i18n-en.ts`, split del 15/08) e `t()` è
// sincrona: senza attendere il catalogo questi casi leggono il fallback italiano
// e falliscono per un motivo che non è quello che vogliono misurare.
await ensureLocaleLoaded('en');


import { ChoiceInput, drawerTask, ids, task } from './taskChoicesFixtures';


describe('taskChoiceState', () => {
  it('card and drawer omit land for empty analyses, missing evidence and integrated deliveries', () => {
    const base = task({ status: 'review', assignedTopicId: 'agent', deliveryBranch: 'task/analysis' });
    for (const evidence of [
      { deliveryFilesChanged: 0, deliveryCommit: null },
      { deliveryFilesChanged: 0, deliveryCommit: 'base-commit', deliveryUncommittedFiles: 0 },
      { deliveryFilesChanged: null, deliveryCommit: null },
      { deliveryFilesChanged: 0, deliveryUncommittedFiles: 2 },
      { deliveryFilesChanged: 3, deliveryUncommittedFiles: 2 },
      { deliveryBranch: null }, { landingState: 'landed' as const }, { landingState: 'superseded' as const },
    ]) {
      const candidate = { ...base, ...evidence };
      expect(ids(candidate)).not.toContain('land');
      expect(ids(candidate)).toContain('accept');
      if (candidate.deliveryBranch) {
        expect(ids(candidate)).toContain('send-back');
        expect(ids(candidate)).toContain('take-over');
        expect(taskChoices(candidate).find((choice) => choice.id === 'accept')?.tone).toBe('primary');
      }
      expect(reviewDecisionButtons(candidate).land).toBeNull();
      expect(drawerSurfaceLabels(candidate)).not.toContain(taskActionWord('land').label);
    }
    for (const evidence of [
      { deliveryFilesChanged: 1 },
      { deliveryFilesChanged: null, deliveryCommit: 'delivered-commit' },
    ]) {
      const candidate = { ...base, ...evidence };
      expect(ids(candidate)).toContain('land');
      expect(reviewDecisionButtons(candidate).land).not.toBeNull();
    }
  });
  // The card the dispatcher set aside: the reason lived in a tooltip and the
  // only gesture was guessing the drag to Todo.
  it('una card parcheggiata (failed/blocked/stopped/waited_out) offre «Rimetti in coda» e «Archivia»', () => {
    for (const dispatchState of ['failed', 'blocked', 'stopped', 'waited_out']) {
      const t = task({ status: 'backlog', dispatchState });
      expect(taskChoiceState(t)).toBe('parked');
      expect(ids(t)).toEqual(['requeue', 'drop']);
    }
    expect(taskActionWord('requeue').label).toBe('Rimetti in coda');
  });

  it('in Todo il parcheggio non offre niente: è già in coda', () => {
    expect(taskChoiceState(task({ status: 'todo', dispatchState: 'failed' }))).toBeNull();
  });

  it('un bloccante aperto vince sul parcheggio: rimettere in coda non farebbe partire niente', () => {
    const t = task({ status: 'backlog', dispatchState: 'failed', blockedByTaskId: 'b1', blockedBy: { id: 'b1', text: 'x', status: 'todo', archived: false } as never });
    expect(taskChoiceState(t)).toBe('blocked');
  });

  it('review con ramo e review senza ramo sono due stati diversi', () => {
    expect(taskChoiceState(task({ status: 'review', assignedTopicId: 'top-1', deliveryBranch: 'task/abc' }))).toBe('review-branch');
    expect(taskChoiceState(task({ status: 'review', assignedTopicId: 'top-1', deliveryBranch: null }))).toBe('review-plain');
    // Consegna umana: nessun agente, quindi nessun ramo da landare.
    expect(taskChoiceState(task({ status: 'review', assignedTopicId: null, deliveryBranch: 'task/abc' }))).toBe('review-plain');
  });

  it('review vince su un dispatch_state stantio (non offre «Ferma» a chi deve decidere)', () => {
    expect(taskChoiceState(task({ status: 'review', assignedTopicId: 't', dispatchState: 'working' }))).toBe('review-plain');
  });

  it('«in corso» è il turno VIVO, non la colonna', () => {
    expect(taskChoiceState(task({ status: 'in_progress', dispatchState: 'working' }))).toBe('working');
    expect(taskChoiceState(task({ status: 'in_progress', dispatchState: 'starting' }))).toBe('working');
    // Presa in mano da una persona: non c'è nessun agente da fermare.
    expect(taskChoiceState(task({ status: 'in_progress', dispatchState: null }))).toBe(null);
  });

  /**
   * IN CODA NON È IN CORSO — e la differenza è un bottone che non fa niente.
   *
   * `isAgentWorking` include `queued` perché per il tetto di concorrenza quella
   * riga è già impegnata. Le scelte però parlano a un AGENTE, e in `queued`
   * l'agente non è ancora nato: «Consegna quello che hai» scrive un commento
   * che il gate di `server/routes/tasks.ts` consegna solo a un task con un topic
   * legato e in review o in corso. Su una card in coda quel commento resta una
   * nota che nessuno leggerà mai — misurate 12 card così sulla board del 13/08.
   */
  it('in coda non è «in corso»: nessun agente da interrogare', () => {
    expect(taskChoiceState(task({ status: 'todo', dispatchState: 'queued' }))).toBe('queued');
    expect(taskChoiceState(task({ status: 'in_progress', dispatchState: 'queued' }))).toBe('queued');
  });

  it('bloccata solo finché il bloccante è davvero aperto', () => {
    const blocked = { blockedByTaskId: 'b1', blockedBy: { id: 'b1', text: 'Migrare le foto', status: 'todo' as const, archived: false } };
    expect(taskChoiceState(task(blocked))).toBe('blocked');
    expect(taskChoiceState(task({ ...blocked, blockedBy: { ...blocked.blockedBy, status: 'done' as const } }))).toBe(null);
    expect(taskChoiceState(task({ ...blocked, blockedBy: { ...blocked.blockedBy, archived: true } }))).toBe(null);
  });

  it('una card chiusa non offre scelte', () => {
    expect(taskChoiceState(task({ status: 'done' }))).toBe(null);
    expect(taskChoices(task({ status: 'done' }))).toEqual([]);
  });
});

describe('taskChoices', () => {
  it('no choice invents its own word: they come from the action table', () => {
    // Surface parity rests on this: card, context menu and drawer ask the same
    // table for the word. If one of them went back to a literal, card and drawer
    // would start calling the same action two things again («Va bene» here and
    // «Approva» there).
    //
    // The LABEL is the invariant, not the tooltip. Two of them legitimately
    // change with the card — «Rimanda indietro» and «Rifai così…» name a
    // different destination when there is no agent to go back to — which is the
    // point: one word, and a sentence that is true.
    const states: ChoiceInput[] = [
      task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }),
      task({ status: 'review' }),
      task({ status: 'in_progress', dispatchState: 'working' }),
    ];
    for (const t of states) {
      for (const c of taskChoices(t)) {
        expect({ id: c.id, label: c.label }).toEqual({ id: c.id, label: taskActionWord(c.id).label });
        expect(c.title.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('review con ramo: landare, rimandare indietro, approvare, prenderselo, archiviare', () => {
    // `accept` e' entrato dopo: landare e chiudere non sono la stessa cosa, e
    // una card il cui lavoro non e' un ramo di questo repo restava senza uscite.
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' })))
      .toEqual(['land', 'send-back', 'accept', 'take-over', 'drop']);
  });

  it('review senza ramo: approva, rifai così, archivia', () => {
    expect(ids(task({ status: 'review' }))).toEqual(['accept', 'redo', 'drop']);
  });

  it('in corso: fermarsi o consegnare quello che c\'è', () => {
    expect(ids(task({ status: 'in_progress', dispatchState: 'working' }))).toEqual(['stop', 'deliver-now']);
  });

  it('in coda: «Consegna quello che hai» non c\'è. Non c\'è nessuno a cui chiederlo', () => {
    const inCoda = task({ status: 'todo', dispatchState: 'queued' });
    expect(ids(inCoda)).toEqual(['stop']);
    // Il bottone che resta funziona per davvero: il taglio del turno accetta
    // `queued` e sgancia il timer di grazia, quindi la card esce dalla coda.
    // La PAROLA resta quella dell'azione (una sola per azione, `taskActionWords`);
    // a cambiare è il tooltip, perché in coda non c'è nessun turno da interrompere.
    const [solo] = taskChoices(inCoda);
    const [fermati] = taskChoices(task({ status: 'in_progress', dispatchState: 'working' }));
    expect(solo!.label).toBe(fermati!.label);
    expect(solo!.title).not.toBe(fermati!.title);
    expect(solo!.title).toBe(stopWord(false).title);
  });

  it('un\'opzione dell\'agente non collide più con un bottone che la card non ha', () => {
    // La quick-reply e la scelta si somigliano e fanno l'OPPOSTO: se la card non
    // disegna «Consegna quello che hai», l'opzione dell'agente deve sopravvivere.
    expect(usableQuestionOptions(task({ status: 'todo', dispatchState: 'queued' }), ['Consegna quello che hai']))
      .toEqual(['Consegna quello che hai']);
    expect(usableQuestionOptions(task({ status: 'in_progress', dispatchState: 'working' }), ['Consegna quello che hai']))
      .toEqual([]);
  });

  it('bloccata: sblocca col nome del bloccante, togli il legame, archivia', () => {
    const blocked = task({
      status: 'backlog',
      blockedByTaskId: 'b1',
      blockedBy: { id: 'b1', text: 'Migrare le foto', status: 'todo', archived: false },
    });
    expect(ids(blocked)).toEqual(['unblock', 'unlink', 'drop']);
    expect(taskChoices(blocked)[0].label).toBe('Sblocca: Migrare le foto');
    expect(taskChoices(blocked)[0].title).toBe(unblockWord('Migrare le foto').title);
  });

  it('il nome lungo del bloccante non sfonda il bottone', () => {
    const long = task({
      blockedByTaskId: 'b1',
      blockedBy: { id: 'b1', text: 'Migrare tutte le foto del catalogo sul nuovo bucket', status: 'todo', archived: false },
    });
    expect(taskChoices(long)[0].label).toBe('Sblocca: Migrare tutte le foto del c…');
  });

  it('senza il titolo del bloccante resta «Sblocca». Non una etichetta vuota', () => {
    expect(taskChoices(task({ blockedByTaskId: 'b1', blockedBy: null }))[0].label).toBe('Sblocca');
  });

  it('già in Todo: «Togli il legame» sarebbe lo stesso click di «Sblocca», quindi non c\'è', () => {
    expect(ids(task({
      status: 'todo',
      blockedByTaskId: 'b1',
      blockedBy: { id: 'b1', text: 'Migrare le foto', status: 'todo', archived: false },
    }))).toEqual(['unblock', 'drop']);
  });

  it('«Rifai così…» è l\'unica che chiede di scrivere', () => {
    const review = taskChoices(task({ status: 'review' }));
    expect(review.filter((c) => c.needsText).map((c) => c.id)).toEqual(['redo']);
  });

  it('exclude toglie le voci che il drawer ha già come bottoni suoi', () => {
    // I bottoni PROPRI del drawer sono tre (`reviewDecisionButtons`): approva,
    // rimanda, landa. Escluderne due su tre lasciava passare il terzo doppio.
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }), { exclude: ['land', 'send-back', 'accept'] }))
      .toEqual(['take-over', 'drop']);
  });

  it('ogni scelta ha etichetta e spiegazione: nessun bottone muto', () => {
    const states: ChoiceInput[] = [
      task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }),
      task({ status: 'review' }),
      task({ status: 'in_progress', dispatchState: 'working' }),
      task({ blockedByTaskId: 'b1', blockedBy: { id: 'b1', text: 'X', status: 'todo', archived: false } }),
    ];
    for (const t of states) {
      const choices = taskChoices(t);
      expect(choices.length).toBeGreaterThanOrEqual(2);
      for (const c of choices) {
        expect(c.label.trim().length).toBeGreaterThan(0);
        expect(c.title.trim().length).toBeGreaterThan(10);
      }
    }
  });
});

/**
 * ONE ACTION, ONE WORD — and this block only claims what it measures.
 *
 * The defect: on the same card the context menu said «Ferma»/«Archivia» while
 * the button row said «Fermati»/«Non serve più», for two different endpoints;
 * between card and drawer approving was «Va bene» here and «Approva» there, and
 * rejecting «Rimanda indietro» against «Rifiuta».
 *
 * The surfaces are JSX and this file does not render them, so it does NOT check
 * "the card and the drawer agree" — an earlier version of this block said it
 * did, comparing `taskChoices` against `taskActionWord`, which is the table
 * against itself, and two real defects walked past it green. What it can hold is
 * the layer below: every word comes from ONE table, the words the drawer decides
 * per card are computed by the function the drawer itself calls
 * (`drawerSurfaceLabels`), and no surface file reads a `board.action.*` key
 * behind the table's back.
 */
describe('one action, one word', () => {
  /** Which state makes the choice row produce that action. */
  const dove: Record<'accept' | 'send-back' | 'stop' | 'drop', ChoiceInput> = {
    'accept': task({ status: 'review' }),
    'send-back': task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }),
    'stop': task({ status: 'in_progress', dispatchState: 'working' }),
    'drop': task({ status: 'review' }),
  };

  for (const [id, stato] of Object.entries(dove) as [TaskChoiceId, ChoiceInput][]) {
    it(`«${id}»: the choice row does not invent its own word`, () => {
      const fromRow = taskChoices(stato).find((c) => c.id === id)!;
      expect(fromRow).toBeDefined();
      expect(fromRow.label).toBe(taskActionWord(id).label);
    });
  }

  it('two actions never share a word: the word is what tells the gestures apart', () => {
    const ids: TaskChoiceId[] = ['land', 'accept', 'send-back', 'redo', 'take-over', 'stop', 'deliver-now', 'drop', 'unblock', 'unlink'];
    const labels = ids.map((id) => taskActionWord(id).label);
    expect(new Set(labels).size).toBe(ids.length);
  });

  it('the stop tooltip names the column the task ends up in', () => {
    // There were three different tooltips for the same button, and only one
    // named Backlog: the other two promised a fate that did not exist.
    expect(taskActionWord('stop').title).toContain('Backlog');
  });

  it('the accept tooltip names the button that DOES merge, without copying its text', () => {
    expect(taskActionWord('accept').title).toContain(taskActionWord('land').label);
  });

  it('no tooltip promises an agent that is not there', () => {
    // Reintroduced once already: the drawer stopped choosing between the two
    // reject tooltips and always drew «Torna all'agente, che riparte sullo
    // stesso tab» — on a review a human filed by hand, naming a tab that does
    // not exist. Same word, and a destination that is true.
    for (const w of [sendBackWord('human'), redoWord(false)]) {
      expect(w.title).not.toContain('agente, che riparte');
      expect(w.title).toContain('In Progress');
    }
    expect(sendBackWord('human').label).toBe(sendBackWord('agent').label);
    expect(redoWord(false).label).toBe(redoWord(true).label);
    expect(sendBackWord('agent').title).toContain('agente');
  });

  it('the choice row picks the no-agent tooltip from the CARD, not from a flag', () => {
    const aMano = task({ status: 'review', assignedTopicId: null });
    const fromAgent = task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' });
    expect(taskChoices(aMano).find((c) => c.id === 'redo')!.title).toBe(redoWord(false).title);
    expect(taskChoices(fromAgent).find((c) => c.id === 'send-back')!.title).toBe(sendBackWord('agent').title);
  });

  it('«Approva comunque» is in the table, not loose next to it', () => {
    // It is the SAME action with the pre-review checks red, and the word on the
    // button changes. Outside the table the de-duplicator did not know it, and
    // left a quick reply reading «Approva comunque» beside the real one.
    expect(acceptWord('checks-red').label).not.toBe(acceptWord(null).label);
    expect(acceptWord(null).label).toBe(taskActionWord('accept').label);
    expect(acceptWord('checks-red').title).toContain(taskActionWord('send-back').label);
  });

  it('drawerSurfaceLabels carries the word the button ACTUALLY draws', () => {
    // The function the drawer calls, not a list retyped beside it: with red
    // checks the button says «Approva comunque», so that is what the
    // de-duplicator must be told is on the screen.
    const rosso = drawerTask({ checksState: 'fail' });
    const verde = drawerTask({ checksState: 'pass' });
    expect(drawerSurfaceLabels(rosso)).toContain(acceptWord('checks-red').label);
    expect(drawerSurfaceLabels(verde)).toContain(acceptWord(null).label);
    expect(drawerSurfaceLabels(verde)).not.toContain(acceptWord('checks-red').label);
    // Land is drawn only on an agent review.
    expect(drawerSurfaceLabels(verde)).toContain(taskActionWord('land').label);
    expect(drawerSurfaceLabels({ ...verde, assignedTopicId: null })).not.toContain(taskActionWord('land').label);
  });

  it('no board surface reads an action key behind the table', () => {
    // The guard the earlier "parity" tests promised and did not give. Points 4
    // and 5 both took the shape of a surface deciding a word on its own, and a
    // file-level check is what a unit test can honestly do about JSX: every
    // `board.action.*` key is read through `taskActionWords.ts`.
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of ['Card.tsx', 'TaskDetail.tsx', 'TaskChoiceRow.tsx', 'taskChoices.ts']) {
      const src = readFileSync(join(dir, f), 'utf8');
      const hits = src.match(/tr\(\s*'board\.action\./g) ?? [];
      expect(hits, `${f} reads a board.action.* key directly`).toEqual([]);
    }
  });

  it('the OS notification says the same word as the button it mirrors', () => {
    // The fourth surface (`shared/notify-actions.ts`), which cannot import the
    // client dictionary and so spells the word by hand. It is always in the
    // fallback locale, which is exactly what the table's fallback gives.
    const approve = buildNotifyActions({ kind: 'review-ready', question: null });
    expect(approve.map((a) => a.title)).toEqual([taskActionWord('accept').label]);
  });
});

