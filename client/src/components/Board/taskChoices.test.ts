import { describe, it, expect } from 'bun:test';
import { taskChoices, taskChoiceState, usableQuestionOptions, type TaskChoiceId } from './taskChoices';
import { taskActionWord, unblockWord } from './taskActionWords';
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
  it('nessuna scelta si inventa le parole: vengono dalla tabella delle azioni', () => {
    // La parità fra le superfici si regge su questo: card, menu contestuale e
    // drawer chiedono la parola alla stessa tabella. Se una di loro tornasse a
    // scrivere un letterale, la card e il drawer ricomincerebbero a chiamare la
    // stessa azione in due modi (era «Va bene» qui e «Approva» là).
    const states: ChoiceInput[] = [
      task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }),
      task({ status: 'review' }),
      task({ status: 'in_progress', dispatchState: 'working' }),
    ];
    for (const t of states) {
      for (const c of taskChoices(t)) {
        expect({ id: c.id, label: c.label, title: c.title })
          .toEqual({ id: c.id, ...taskActionWord(c.id) });
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
 * PARITÀ FRA LE SUPERFICI — una azione, una parola.
 *
 * Il guasto misurato: sulla stessa card il menu contestuale diceva
 * «Ferma»/«Archivia» e la riga di bottoni «Fermati»/«Non serve più», per due
 * endpoint diversi; fra card e drawer approvare era «Va bene» di qua e
 * «Approva» di là, e rifiutare «Rimanda indietro» contro «Rifiuta».
 *
 * Le superfici sono JSX e questo test non le renderizza: quello che può fare è
 * tenere UNA sorgente. Il menu contestuale della card, i bottoni propri del
 * drawer e la riga di scelte leggono tutti `taskActionWord`, quindi qui si
 * verifica che la riga di scelte non se ne stacchi, che due azioni non
 * condividano una parola, e che il tooltip dica dove il task finisce.
 */
describe('parità delle parole fra card, menu e drawer', () => {
  /** In quale stato la riga di scelte produce quell'azione. */
  const dove: Record<'accept' | 'send-back' | 'stop' | 'drop', ChoiceInput> = {
    'accept': task({ status: 'review' }),
    'send-back': task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }),
    'stop': task({ status: 'in_progress', dispatchState: 'working' }),
    'drop': task({ status: 'review' }),
  };

  for (const [id, stato] of Object.entries(dove) as [TaskChoiceId, ChoiceInput][]) {
    it(`«${id}»: la riga di scelte e le altre superfici dicono la stessa cosa`, () => {
      const dallaRiga = taskChoices(stato).find((c) => c.id === id)!;
      expect(dallaRiga).toBeDefined();
      // `taskActionWord` è ciò che disegnano il menu contestuale della card
      // (stop, drop) e i bottoni propri del drawer (accept, send-back).
      const dallaTabella = taskActionWord(id);
      expect(dallaRiga.label).toBe(dallaTabella.label);
      expect(dallaRiga.title).toBe(dallaTabella.title);
    });
  }

  it('due azioni non condividono una parola: la parola distingue il gesto', () => {
    const ids: TaskChoiceId[] = ['land', 'accept', 'send-back', 'redo', 'take-over', 'stop', 'deliver-now', 'drop', 'unblock', 'unlink'];
    const labels = ids.map((id) => taskActionWord(id).label);
    expect(new Set(labels).size).toBe(ids.length);
  });

  it('il tooltip di «Ferma» nomina la colonna in cui il task finisce', () => {
    // Erano tre tooltip diversi per lo stesso bottone, e uno solo nominava
    // Backlog: gli altri due promettevano un destino che non c'era.
    expect(taskActionWord('stop').title).toContain('Backlog');
  });

  it('il tooltip di «Approva» nomina il bottone che invece fonde, senza copiarne il testo', () => {
    // Il testo del bottone land arriva dalla stessa tabella, interpolato: una
    // copia a mano è il modo in cui due parole tornano a divergere.
    expect(taskActionWord('accept').title).toContain(taskActionWord('land').label);
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

  it('«Approva» sparisce perché il drawer lo disegna, «Approva il piano» resta', () => {
    // Il caso vero (commento 2eff6a44): la card è review CON ramo, quindi le sue
    // scelte sono land / send-back / take-over e «Approva» non è fra loro. Il
    // drawer però lo disegna comunque, in grande: senza `surfaceLabels` la
    // risposta rapida omonima passava, e premerla RIFIUTAVA il task.
    const disegnate = [taskActionWord('accept').label, taskActionWord('send-back').label, taskActionWord('land').label];
    expect(usableQuestionOptions(consegnata, ['Approva'])).toEqual(['Approva']);
    expect(usableQuestionOptions(consegnata, ['Approva'], { surfaceLabels: disegnate })).toEqual([]);
    // «Approva il piano» è un'ALTRA cosa: è una risposta all'agente, non il
    // bottone della decisione. Un de-duplicatore che tagliasse anche questa
    // toglierebbe l'unico modo di rispondere.
    expect(usableQuestionOptions(consegnata, ['Approva il piano'], { surfaceLabels: disegnate }))
      .toEqual(['Approva il piano']);
  });

  it('leaves everything alone when the task has no choices', () => {
    const chiusa = { ...consegnata, status: 'done' as const };
    expect(usableQuestionOptions(chiusa, ['Landa su main'])).toEqual(['Landa su main']);
  });
});
