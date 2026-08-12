import { describe, it, expect } from 'bun:test';
import { taskChoices, taskChoiceState, type TaskChoiceId } from './taskChoices';
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

  it('review vince su un dispatch_state stantio (non offre «Fermati» a chi deve decidere)', () => {
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
  it('review con ramo: landare, rimandare indietro, prenderselo', () => {
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' })))
      .toEqual(['land', 'send-back', 'take-over']);
  });

  it('review senza ramo: va bene, rifai così, non serve più', () => {
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
