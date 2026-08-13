import { describe, expect, test } from 'bun:test';
import type { BoardTask } from './board';
import { between, compareTasks, groupByStatus, planDrop } from './boardOrder';

/** Un BoardTask con solo i campi che l'ordinamento guarda. */
function task(over: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    projectId: 'pX', text: over.id, description: null, status: 'todo', priority: 2,
    priorityAuto: false, kanbanOrder: 0, assignedTo: null, dueDate: null,
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
    assignedTopicId: null, dispatchState: null, dispatchError: null, parentTaskId: null,
    outputUrl: null, previewImage: null, planFirst: false, inProgressAt: null,
    agentMs: 0, agentTokens: 0, agentCacheReadTokens: 0, subtaskCount: 0, subtaskDoneCount: 0,
    userCommentCount: 0, model: null, blockedByTaskId: null, reuseBlockerContext: false,
    deliveryBranch: null, deliveryCommit: null, landingState: null, landingCheckedAt: null,
    checksState: null, checksAt: null, checksCommit: null, checks: null,
    deliveredBy: null, deliveredReason: null,
    ...over,
  } as BoardTask;
}

const col = (tasks: BoardTask[], scope: 'board' | 'cross-project' = 'board') =>
  groupByStatus(tasks, scope);

describe('compareTasks', () => {
  test('board: comanda kanbanOrder', () => {
    const a = task({ id: 'a', kanbanOrder: 2 });
    const b = task({ id: 'b', kanbanOrder: 1 });
    expect([a, b].sort(compareTasks('board')).map((t) => t.id)).toEqual(['b', 'a']);
  });

  test('board: a parità di kanbanOrder l\'ordine è comunque deterministico', () => {
    // Il caso che faceva ballare le card fra un refetch e l'altro: stesso numero,
    // ordine di arrivo diverso, risultato diverso. Ora no.
    const a = task({ id: 'a', kanbanOrder: 1, createdAt: '2026-01-02T00:00:00.000Z' });
    const b = task({ id: 'b', kanbanOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' });
    expect([a, b].sort(compareTasks('board')).map((t) => t.id)).toEqual(['b', 'a']);
    expect([b, a].sort(compareTasks('board')).map((t) => t.id)).toEqual(['b', 'a']);
  });

  test('board: pari anche di data → decide l\'id, ma decide SEMPRE uguale', () => {
    const a = task({ id: 'zzz', kanbanOrder: 1 });
    const b = task({ id: 'aaa', kanbanOrder: 1 });
    expect([a, b].sort(compareTasks('board')).map((t) => t.id)).toEqual(['aaa', 'zzz']);
    expect([b, a].sort(compareTasks('board')).map((t) => t.id)).toEqual(['aaa', 'zzz']);
  });

  test('cross-project: kanbanOrder è ignorato, comanda la data di creazione', () => {
    // Due board diverse: il 300 non è "più in fondo" del 3, è solo di un progetto
    // con più task alle spalle.
    const vecchio = task({ id: 'vecchio', projectId: 'pY', kanbanOrder: 300, createdAt: '2026-01-01T00:00:00.000Z' });
    const nuovo = task({ id: 'nuovo', projectId: 'pX', kanbanOrder: 3, createdAt: '2026-02-01T00:00:00.000Z' });
    expect([nuovo, vecchio].sort(compareTasks('cross-project')).map((t) => t.id)).toEqual(['vecchio', 'nuovo']);
  });
});

describe('groupByStatus', () => {
  test('una colonna per stato, sempre, anche vuote', () => {
    const g = groupByStatus([task({ id: 'a', status: 'review' })], 'board');
    expect(Object.keys(g).sort()).toEqual(['backlog', 'done', 'in_progress', 'review', 'todo']);
    expect(g.review.map((t) => t.id)).toEqual(['a']);
    expect(g.todo).toEqual([]);
  });

  test('review è una casella di posta: comanda l\'ultimo aggiornamento', () => {
    const vecchia = task({ id: 'vecchia', status: 'review', kanbanOrder: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    const fresca = task({ id: 'fresca', status: 'review', kanbanOrder: 99, updatedAt: '2026-03-01T00:00:00.000Z' });
    expect(groupByStatus([vecchia, fresca], 'board').review.map((t) => t.id)).toEqual(['fresca', 'vecchia']);
  });

  test('review: pari-merito di data → comunque un ordine solo', () => {
    const a = task({ id: 'zzz', status: 'review' });
    const b = task({ id: 'aaa', status: 'review' });
    expect(groupByStatus([a, b], 'board').review.map((t) => t.id)).toEqual(['aaa', 'zzz']);
    expect(groupByStatus([b, a], 'board').review.map((t) => t.id)).toEqual(['aaa', 'zzz']);
  });

  test('done è una cronologia: l\'ultimo chiuso sta in cima, kanbanOrder non conta', () => {
    // Il caso vero: si approva dalla review, il server scrive `completed_at` e
    // basta. `kanbanOrder` resta quello della colonna da cui la card veniva —
    // qui il 99 — e prima bastava a seppellirla in fondo a Done.
    const vecchio = task({ id: 'vecchio', status: 'done', kanbanOrder: 1, completedAt: '2026-01-01T00:00:00.000Z' });
    const appena = task({ id: 'appena', status: 'done', kanbanOrder: 99, completedAt: '2026-03-01T00:00:00.000Z' });
    expect(groupByStatus([vecchio, appena], 'board').done.map((t) => t.id)).toEqual(['appena', 'vecchio']);
    expect(groupByStatus([appena, vecchio], 'board').done.map((t) => t.id)).toEqual(['appena', 'vecchio']);
  });

  test('done: senza completedAt (righe vecchie) si ripiega su updatedAt', () => {
    const senza = task({ id: 'senza', status: 'done', completedAt: null, updatedAt: '2026-02-01T00:00:00.000Z' });
    const con = task({ id: 'con', status: 'done', completedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(groupByStatus([con, senza], 'board').done.map((t) => t.id)).toEqual(['senza', 'con']);
  });

  test('done: stesso ordine anche nella board generale', () => {
    // Lì `kanbanOrder` non è nemmeno comparabile fra progetti: la data di
    // chiusura è l'unica chiave che significa la stessa cosa ovunque.
    const px = task({ id: 'px', projectId: 'pX', status: 'done', kanbanOrder: 300, completedAt: '2026-01-01T00:00:00.000Z' });
    const py = task({ id: 'py', projectId: 'pY', status: 'done', kanbanOrder: 1, completedAt: '2026-03-01T00:00:00.000Z' });
    expect(groupByStatus([px, py], 'cross-project').done.map((t) => t.id)).toEqual(['py', 'px']);
  });

  test('done: pari-merito di data → comunque un ordine solo', () => {
    const a = task({ id: 'zzz', status: 'done' });
    const b = task({ id: 'aaa', status: 'done' });
    expect(groupByStatus([a, b], 'board').done.map((t) => t.id)).toEqual(['aaa', 'zzz']);
    expect(groupByStatus([b, a], 'board').done.map((t) => t.id)).toEqual(['aaa', 'zzz']);
  });
});

describe('between', () => {
  test('colonna vuota, in testa, in coda, in mezzo', () => {
    expect(between(undefined, undefined)).toBe(1);
    expect(between(undefined, 5)).toBe(4);
    expect(between(5, undefined)).toBe(6);
    expect(between(2, 4)).toBe(3);
  });
});

describe('planDrop', () => {
  const a = task({ id: 'a', kanbanOrder: 1 });
  const b = task({ id: 'b', kanbanOrder: 2 });
  const c = task({ id: 'c', kanbanOrder: 3 });
  const byStatus = col([a, b, c]);

  test('rilascio sulla card di un\'altra colonna → cambia stato e prende il suo posto', () => {
    const r = task({ id: 'r', status: 'review', kanbanOrder: 10 });
    const g = col([a, b, c, r]);
    expect(planDrop({ task: r, overId: 'b', byStatus: g, scope: 'board' }))
      .toEqual({ patch: { status: 'todo', kanbanOrder: 1.5 } }); // fra a(1) e b(2)
  });

  test('rilascio sull\'area vuota di una colonna → in fondo', () => {
    const r = task({ id: 'r', status: 'review', kanbanOrder: 10 });
    const g = col([a, b, c, r]);
    expect(planDrop({ task: r, overId: 'todo', byStatus: g, scope: 'board' }))
      .toEqual({ patch: { status: 'todo', kanbanOrder: 4 } }); // dopo c(3)
  });

  test('stessa colonna verso il BASSO: si finisce DOPO la card di arrivo', () => {
    // a (1) rilasciata su b (2): b stava sotto, quindi a prende il posto DI b,
    // cioè fra b(2) e c(3).
    expect(planDrop({ task: a, overId: 'b', byStatus, scope: 'board' }))
      .toEqual({ patch: { kanbanOrder: 2.5 } });
  });

  test('stessa colonna verso l\'ALTO: si finisce PRIMA della card di arrivo', () => {
    // c (3) rilasciata su b (2): si infila fra a(1) e b(2).
    expect(planDrop({ task: c, overId: 'b', byStatus, scope: 'board' }))
      .toEqual({ patch: { kanbanOrder: 1.5 } });
  });

  test('verso l\'alto fino in cima', () => {
    expect(planDrop({ task: c, overId: 'a', byStatus, scope: 'board' }))
      .toEqual({ patch: { kanbanOrder: 0 } }); // prima di a(1)
  });

  test('drop su se stessa, o senza bersaglio, non fa niente', () => {
    expect(planDrop({ task: a, overId: 'a', byStatus, scope: 'board' })).toBeNull();
    expect(planDrop({ task: a, overId: null, byStatus, scope: 'board' })).toBeNull();
  });

  test('drop che non sposta nulla non produce una PATCH', () => {
    // b rilasciata sulla propria colonna quando è già l'ultima... non lo è: usa
    // c, che è già in fondo.
    expect(planDrop({ task: c, overId: 'todo', byStatus, scope: 'board' })).toBeNull();
  });

  test('bersaglio sparito sotto le dita → nessuna posizione inventata', () => {
    expect(planDrop({ task: a, overId: 'fantasma', byStatus, scope: 'board' })).toBeNull();
  });

  test('interstizio esaurito: si rinumera la colonna invece di non fare niente', () => {
    // Due vicini contigui in virgola mobile: `between` ricade su uno dei due e
    // la card non avrebbe un posto. Prima il drag moriva in silenzio.
    const x = task({ id: 'x', kanbanOrder: 1 });
    const y = task({ id: 'y', kanbanOrder: 1 + Number.EPSILON });
    const z = task({ id: 'z', kanbanOrder: 5 });
    const g = col([x, y, z]);
    const plan = planDrop({ task: z, overId: 'y', byStatus: g, scope: 'board' })!;
    expect(plan).not.toBeNull();
    // z si infila fra x e y → posizione 2 su interi, e gli altri seguono.
    expect(plan.patch).toEqual({ kanbanOrder: 2 });
    expect(plan.renumber).toEqual([
      { id: 'x', kanbanOrder: 1 },
      { id: 'y', kanbanOrder: 3 },
    ]);
    // La rinumerazione non include mai la card trascinata (già in `patch`).
    expect(plan.renumber!.some((r) => r.id === 'z')).toBe(false);
  });

  test('interstizio esaurito arrivando da un\'ALTRA colonna: porta anche lo stato', () => {
    const x = task({ id: 'x', kanbanOrder: 1 });
    const y = task({ id: 'y', kanbanOrder: 1 + Number.EPSILON });
    const fuori = task({ id: 'fuori', status: 'backlog', kanbanOrder: 9 });
    const g = col([x, y, fuori]);
    const plan = planDrop({ task: fuori, overId: 'y', byStatus: g, scope: 'board' })!;
    expect(plan.patch).toEqual({ status: 'todo', kanbanOrder: 2 });
    expect(plan.renumber).toEqual([
      { id: 'x', kanbanOrder: 1 },
      { id: 'y', kanbanOrder: 3 },
    ]);
  });

  test('review: ci si entra, non ci si riordina', () => {
    const r1 = task({ id: 'r1', status: 'review', kanbanOrder: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    const r2 = task({ id: 'r2', status: 'review', kanbanOrder: 2, updatedAt: '2026-02-01T00:00:00.000Z' });
    const g = col([a, b, c, r1, r2]);
    // Entrare in review: solo lo stato, nessun numero derivato da vicini
    // ordinati per data.
    expect(planDrop({ task: a, overId: 'r2', byStatus: g, scope: 'board' })).toEqual({ patch: { status: 'review' } });
    // Riordinare dentro review non fa niente.
    expect(planDrop({ task: r1, overId: 'r2', byStatus: g, scope: 'board' })).toBeNull();
  });

  test('done: ci si entra, non ci si riordina', () => {
    const d1 = task({ id: 'd1', status: 'done', kanbanOrder: 1, completedAt: '2026-01-01T00:00:00.000Z' });
    const d2 = task({ id: 'd2', status: 'done', kanbanOrder: 2, completedAt: '2026-02-01T00:00:00.000Z' });
    const g = col([a, b, c, d1, d2]);
    // Chiudere trascinando: solo lo stato. Il server scrive completedAt, ed è
    // QUELLO a decidere dove la card atterra — un kanbanOrder scritto qui non si
    // vedrebbe, e la seguirebbe fuori se la si riaprisse.
    expect(planDrop({ task: a, overId: 'd2', byStatus: g, scope: 'board' })).toEqual({ patch: { status: 'done' } });
    expect(planDrop({ task: a, overId: 'done', byStatus: g, scope: 'board' })).toEqual({ patch: { status: 'done' } });
    // Riordinare dentro done non fa niente.
    expect(planDrop({ task: d1, overId: 'd2', byStatus: g, scope: 'board' })).toBeNull();
  });

  describe('In Progress non è una coda: il drop viene reindirizzato in Todo', () => {
    // Il dispatcher lista SOLO `status: "todo"`, quindi una card lasciata a mano
    // in In Progress non la raccoglie nessuno — e uscire da Todo annulla pure il
    // dispatch già in coda. Il drop finisce dove il gesto voleva andare, cioè in
    // coda, e chi trascina lo sa perché il piano lo dichiara.
    const wip = task({ id: 'w', status: 'in_progress', kanbanOrder: 7 });

    test('senza agente: la card va in Todo, in fondo, e il piano lo DICE', () => {
      const arretrata = task({ id: 'arretrata', status: 'backlog', kanbanOrder: 9 });
      const g = col([a, b, c, wip, arretrata]);
      expect(planDrop({ task: arretrata, overId: 'in_progress', byStatus: g, scope: 'board' }))
        .toEqual({ patch: { status: 'todo', kanbanOrder: 4 }, redirectedFrom: 'in_progress' });
    });

    test('rilasciata SOPRA una card di In Progress: stessa deviazione, e la posizione di quella card non conta', () => {
      // `w` sta in un'altra colonna: il suo posto non dice niente su dove questa
      // card vada in Todo. Si accoda, dopo c(3).
      const arretrata = task({ id: 'arretrata', status: 'backlog', kanbanOrder: 9 });
      const g = col([a, b, c, wip, arretrata]);
      expect(planDrop({ task: arretrata, overId: 'w', byStatus: g, scope: 'board' }))
        .toEqual({ patch: { status: 'todo', kanbanOrder: 4 }, redirectedFrom: 'in_progress' });
    });

    test('CON un agente vivo la card resta dov\'è: quella è una presa in carico legittima', () => {
      const presa = task({ id: 'presa', status: 'backlog', kanbanOrder: 9, assignedTopicId: 'topic-1' });
      const g = col([a, b, c, wip, presa]);
      const plan = planDrop({ task: presa, overId: 'in_progress', byStatus: g, scope: 'board' })!;
      expect(plan.patch.status).toBe('in_progress');
      expect(plan.redirectedFrom).toBeUndefined();
    });

    test('già in Todo: niente da scrivere, ma la deviazione si dice lo stesso', () => {
      // c è già l'ultima di Todo: la patch sarebbe vuota. Il piano esiste solo
      // per portare il motivo, e `dropTo` non spedisce niente.
      const g = col([a, b, c, wip]);
      expect(planDrop({ task: c, overId: 'in_progress', byStatus: g, scope: 'board' }))
        .toEqual({ patch: {}, redirectedFrom: 'in_progress' });
    });

    test('vale anche nella board generale, dove la posizione non si scrive', () => {
      const altro = task({ id: 'altro', projectId: 'pY', status: 'backlog', kanbanOrder: 300 });
      const g = col([a, b, c, altro], 'cross-project');
      expect(planDrop({ task: altro, overId: 'in_progress', byStatus: g, scope: 'cross-project' }))
        .toEqual({ patch: { status: 'todo' }, redirectedFrom: 'in_progress' });
    });

    test('board generale, card già in Todo: nessuna patch, ma il motivo c\'è', () => {
      const g = col([a, b, c], 'cross-project');
      expect(planDrop({ task: a, overId: 'in_progress', byStatus: g, scope: 'cross-project' }))
        .toEqual({ patch: {}, redirectedFrom: 'in_progress' });
    });

    test('riordinare DENTRO In Progress non è una deviazione', () => {
      // Due card già lì: nessuna delle due sta chiedendo di entrare, quindi il
      // drop resta un riordino normale.
      const w1 = task({ id: 'w1', status: 'in_progress', kanbanOrder: 1, assignedTopicId: 't1' });
      const w2 = task({ id: 'w2', status: 'in_progress', kanbanOrder: 2, assignedTopicId: 't2' });
      const g = col([w1, w2]);
      const plan = planDrop({ task: w2, overId: 'w1', byStatus: g, scope: 'board' })!;
      expect(plan.redirectedFrom).toBeUndefined();
      expect(plan.patch).toEqual({ kanbanOrder: 0 });
    });
  });

  test('cross-project: si cambia stato, MAI la posizione', () => {
    // Riordinare nella board generale scriveva un kanbanOrder calcolato sui
    // vicini di ALTRI progetti, e quel numero spostava poi la card in un punto a
    // caso della sua board vera.
    const altro = task({ id: 'altro', projectId: 'pY', status: 'review', kanbanOrder: 300 });
    const g = col([a, b, c, altro], 'cross-project');
    expect(planDrop({ task: altro, overId: 'b', byStatus: g, scope: 'cross-project' }))
      .toEqual({ patch: { status: 'todo' } });
    expect(planDrop({ task: a, overId: 'b', byStatus: g, scope: 'cross-project' })).toBeNull();
    expect(planDrop({ task: a, overId: 'todo', byStatus: g, scope: 'cross-project' })).toBeNull();
  });
});
