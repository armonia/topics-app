import { describe, it, expect } from 'bun:test';
import { taskChoices, taskChoiceState, usableQuestionOptions, type TaskChoiceId } from './taskChoices';
import { acceptWord, drawerSurfaceLabels, redoWord, sendBackWord, stopWord, taskActionWord, unblockWord } from './taskActionWords';
import { LAND_ACTION_LABEL } from '../../lib/board';
import { t as translate } from '../../lib/i18n';
import { buildNotifyActions } from '../../../../shared/notify-actions';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardTask } from '../../lib/board';

type ChoiceInput = Parameters<typeof taskChoices>[0];

/** Solo i campi da cui nascono le scelte: il resto della card non c'entra. */
function task(over: Partial<ChoiceInput> = {}): ChoiceInput {
  return {
    status: 'todo' as BoardTask['status'],
    assignedTopicId: null,
    deliveryBranch: null,
    dispatchState: null,
    blockedByTaskId: null,
    blockedBy: null,
    ...over,
  };
}
const ids = (t: ChoiceInput, opts?: { exclude?: TaskChoiceId[] }) => taskChoices(t, opts).map((c) => c.id);

describe('taskChoiceState', () => {
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

  it('review con ramo: landare, rimandare indietro, prenderselo', () => {
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' })))
      .toEqual(['land', 'send-back', 'take-over']);
  });

  it('review senza ramo: approva, rifai così, archivia', () => {
    expect(ids(task({ status: 'review' }))).toEqual(['accept', 'redo', 'drop']);
  });

  it('in corso: fermarsi o consegnare quello che c\'è', () => {
    expect(ids(task({ status: 'in_progress', dispatchState: 'working' }))).toEqual(['stop', 'deliver-now']);
  });

  it('in coda: «Consegna quello che hai» non c\'è — non c\'è nessuno a cui chiederlo', () => {
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

  it('senza il titolo del bloccante resta «Sblocca» — non una etichetta vuota', () => {
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
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }), { exclude: ['land', 'send-back'] }))
      .toEqual(['take-over']);
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
    for (const w of [sendBackWord(false), redoWord(false)]) {
      expect(w.title).not.toContain('agente, che riparte');
      expect(w.title).toContain('In Progress');
    }
    expect(sendBackWord(false).label).toBe(sendBackWord(true).label);
    expect(redoWord(false).label).toBe(redoWord(true).label);
    expect(sendBackWord(true).title).toContain('agente');
  });

  it('the choice row picks the no-agent tooltip from the CARD, not from a flag', () => {
    const aMano = task({ status: 'review', assignedTopicId: null });
    const daAgente = task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' });
    expect(taskChoices(aMano).find((c) => c.id === 'redo')!.title).toBe(redoWord(false).title);
    expect(taskChoices(daAgente).find((c) => c.id === 'send-back')!.title).toBe(sendBackWord(true).title);
  });

  it('«Approva comunque» is in the table, not loose next to it', () => {
    // It is the SAME action with the pre-review checks red, and the word on the
    // button changes. Outside the table the de-duplicator did not know it, and
    // left a quick reply reading «Approva comunque» beside the real one.
    expect(acceptWord(true).label).not.toBe(acceptWord(false).label);
    expect(acceptWord(false).label).toBe(taskActionWord('accept').label);
    expect(acceptWord(true).title).toContain(taskActionWord('send-back').label);
  });

  it('drawerSurfaceLabels carries the word the button ACTUALLY draws', () => {
    // The function the drawer calls, not a list retyped beside it: with red
    // checks the button says «Approva comunque», so that is what the
    // de-duplicator must be told is on the screen.
    const rosso = { status: 'review' as const, assignedTopicId: 't', checksState: 'fail' as const };
    const verde = { ...rosso, checksState: 'pass' as const };
    expect(drawerSurfaceLabels(rosso)).toContain(acceptWord(true).label);
    expect(drawerSurfaceLabels(verde)).toContain(acceptWord(false).label);
    expect(drawerSurfaceLabels(verde)).not.toContain(acceptWord(true).label);
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

describe('usableQuestionOptions', () => {
  // A delivered card with a branch: its real choices are
  // "Landa su main" / "Rimanda indietro" / "Serve a me".
  const consegnata = {
    status: 'review' as const,
    assignedTopicId: 'topic-1',
    deliveryBranch: 'topics/x',
    dispatchState: null,
    blockedByTaskId: null,
    blockedBy: null,
  };

  it('drops an option that collides with a real choice', () => {
    // The measured case (card c57e1aa4): the agent offered "Landa su main" as
    // its only option, drawn right above the button that actually merges.
    expect(usableQuestionOptions(consegnata, ['Landa su main'])).toEqual([]);
  });

  it('keeps options that are genuinely answers', () => {
    expect(usableQuestionOptions(consegnata, ['Sì', 'No, rifai il ritaglio']))
      .toEqual(['Sì', 'No, rifai il ritaglio']);
  });

  it('matches ignoring case, spacing and trailing punctuation', () => {
    expect(usableQuestionOptions(consegnata, ['  landa   su MAIN.  ', 'Altro'])).toEqual(['Altro']);
  });

  it('exclude alone looks at the wrong screen, and surfaceLabels fixes it', () => {
    // `exclude` means "not in the choice ROW", which for the drawer is true
    // precisely because it draws that button ITSELF, bigger. Reading exclude
    // alone therefore hid the collision instead of catching it.
    expect(usableQuestionOptions(consegnata, ['Landa su main'], { exclude: ['land'] }))
      .toEqual(['Landa su main']);
    expect(usableQuestionOptions(consegnata, ['Landa su main'], {
      exclude: ['land'],
      surfaceLabels: [taskActionWord('land').label],
    })).toEqual([]);
  });

  it('«Approva» goes because the drawer draws it, «Approva il piano» stays', () => {
    // The real case (comment 2eff6a44): the card is a review WITH a branch, so
    // its choices are land / send-back / take-over and «Approva» is not among
    // them. The drawer draws it anyway, big: without `surfaceLabels` the
    // identical quick reply survived, and pressing it REJECTED the task.
    const disegnate = [taskActionWord('accept').label, taskActionWord('send-back').label, taskActionWord('land').label];
    expect(usableQuestionOptions(consegnata, ['Approva'])).toEqual(['Approva']);
    expect(usableQuestionOptions(consegnata, ['Approva'], { surfaceLabels: disegnate })).toEqual([]);
    // «Approva il piano» is ANOTHER thing: an answer to the agent, not the
    // decision button. A de-duplicator that cut this one too would remove the
    // only way to reply.
    expect(usableQuestionOptions(consegnata, ['Approva il piano'], { surfaceLabels: disegnate }))
      .toEqual(['Approva il piano']);
  });

  it('leaves everything alone when the task has no choices', () => {
    const chiusa = { ...consegnata, status: 'done' as const };
    expect(usableQuestionOptions(chiusa, ['Landa su main'])).toEqual(['Landa su main']);
  });
});

/**
 * THE DE-DUPLICATOR IN ANOTHER LANGUAGE.
 *
 * It used to work in every locale by accident: the labels here were Italian
 * literals, and the agent's options are Italian by construction. Translating the
 * buttons turned that accident into a hole — under `en` the button reads "Land
 * on main", the option still reads «Landa su main», nothing matched, and the
 * twin came back next to the real button.
 */
describe('usableQuestionOptions, locale en', () => {
  const en = (k: string, vars?: Record<string, string | number>) => translate(k, 'en', vars);
  const consegnata = {
    status: 'review' as const,
    assignedTopicId: 'topic-1',
    deliveryBranch: 'topics/x',
    dispatchState: null,
    blockedByTaskId: null,
    blockedBy: null,
  };

  it('the fallback word for land IS the string the server executes', () => {
    // The anchor for all of this: the server matches the picked option against
    // `LAND_ACTION_LABEL` by value, untranslated. Retranslate the Italian side
    // of `board.action.land` and the button stops naming the action the server
    // would run — this test is what says so out loud.
    expect(taskActionWord('land').label).toBe(LAND_ACTION_LABEL);
  });

  it('subtracts the agent\'s word even when the button is in English', () => {
    expect(en('board.action.land')).toBe('Land on main');
    expect(usableQuestionOptions(consegnata, [LAND_ACTION_LABEL, 'Do something else'], { t: en }))
      .toEqual(['Do something else']);
  });

  it('and it subtracts the ENGLISH word too, for an agent that answers in English', () => {
    expect(usableQuestionOptions(consegnata, ['Land on main', 'Do something else'], { t: en }))
      .toEqual(['Do something else']);
  });

  it('the drawer\'s own buttons carry both names', () => {
    const labels = drawerSurfaceLabels({ status: 'review', assignedTopicId: 't', checksState: null }, en);
    expect(labels).toContain('Approve');
    expect(labels).toContain('Approva');
    expect(usableQuestionOptions(consegnata, ['Approva', 'Rimanda indietro', 'Qualcos\'altro'], { t: en, surfaceLabels: labels }))
      .toEqual(['Qualcos\'altro']);
  });

  it('a decorated option is the same door: the server thinks so too', () => {
    // `normalizeActionLabel` is the server's own comparison, so the board
    // subtracts exactly what the route would treat as the reserved action.
    expect(usableQuestionOptions(consegnata, ['🚀 Landa su main!'], { t: en })).toEqual([]);
  });
});
