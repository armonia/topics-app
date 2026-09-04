/**
 * Which actions a card offers, and with which words: review (land / approve /
 * send back), a live turn (stop / deliver what you have), a blocked task.
 *
 * @covers KANBAN-05, KANBAN-07
 */
import { describe, it, expect } from 'bun:test';
import { choiceForText, taskChoices, taskChoiceState, usableQuestionOptions, VERDICT_CHOICES, type TaskChoiceId } from './taskChoices';
import { acceptWord, drawerSurfaceLabels, landWord, redoWord, reviewDecisionButtons, sendBackWord, stopWord, taskActionWord, unblockWord } from './taskActionWords';
import { LAND_ACTION_LABEL } from '../../lib/board';
import { t as translate, ensureLocaleLoaded } from '../../lib/i18n';
import { buildNotifyActions } from '../../../../shared/notify-actions';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardTask } from '../../lib/board';

// L'inglese vive in un chunk suo (`i18n-en.ts`, split del 15/08) e `t()` è
// sincrona: senza attendere il catalogo questi casi leggono il fallback italiano
// e falliscono per un motivo che non è quello che vogliono misurare.
await ensureLocaleLoaded('en');


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
    // Nessuno l'ha ancora portata in review: è la card «normale» da cui partono
    // quasi tutti i casi qui sotto.
    deliveredBy: null,
    deliveredReason: null,
    // Pre-review checks not run: the "normal" card is not an exception, and the
    // words stay plain.
    checksState: null,
    ...over,
  };
}

/** I campi che servono ai bottoni GRANDI del drawer (un Pick diverso). */
function drawerTask(over: Partial<Parameters<typeof reviewDecisionButtons>[0]> = {}): Parameters<typeof reviewDecisionButtons>[0] {
  return {
    status: 'review' as BoardTask['status'],
    assignedTopicId: 'top-1',
    checksState: null,
    deliveredBy: 'agent',
    deliveredReason: null,
    ...over,
  };
}
const ids = (t: ChoiceInput, opts?: { exclude?: TaskChoiceId[] }) => taskChoices(t, opts).map((c) => c.id);

describe('taskChoiceState', () => {
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

  it('review con ramo: landare, rimandare indietro, approvare, prenderselo', () => {
    // `accept` e' entrato dopo: landare e chiudere non sono la stessa cosa, e
    // una card il cui lavoro non e' un ramo di questo repo restava senza uscite.
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' })))
      .toEqual(['land', 'send-back', 'accept', 'take-over']);
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
    // I bottoni PROPRI del drawer sono tre (`reviewDecisionButtons`): approva,
    // rimanda, landa. Escluderne due su tre lasciava passare il terzo doppio.
    expect(ids(task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' }), { exclude: ['land', 'send-back', 'accept'] }))
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

/**
 * UNA REVIEW PORTATA DAL SISTEMA NON È UNA CONSEGNA.
 *
 * Il difetto, misurato il 13/08 su due card vere: 5472e584 aveva consegnato,
 * c0849d9d era finita in review col turno esaurito, e sulla board erano
 * indistinguibili. Non solo nell'aspetto: nelle SCELTE. Entrambe portavano
 * «Landa su main» verde sulla card e «Approva» verde nel drawer, cioè le due
 * azioni che chiudono, offerte come consigliate su una card sotto cui non c'era
 * niente. Il chip «non consegnato» esisteva dal 29/07 e diceva la cosa giusta,
 * ma viveva accanto a dei bottoni che dicevano il contrario.
 *
 * Questo blocco tiene la distinzione dove conta: nello STATO, nelle PAROLE e nel
 * TONO. Togliere `isUnfinishedReview` da `taskChoiceState` lo fa diventare rosso.
 */
describe('review portata dal sistema: le scelte non sono quelle di una consegna', () => {
  const consegnata = task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'topics/x', deliveredBy: 'agent' });
  const reaper = task({ ...consegnata, deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
  const byId = (t: ChoiceInput) => new Map(taskChoices(t).map((c) => [c.id, c]));

  it('a parità di ramo e di agente, lo stato è un altro', () => {
    expect(taskChoiceState(consegnata)).toBe('review-branch');
    expect(taskChoiceState(reaper)).toBe('review-unfinished');
    // Il modello che si rifiuta, e la consegna di sistema senza causa scritta.
    expect(taskChoiceState(task({ ...reaper, deliveredReason: 'model_refused' }))).toBe('review-unfinished');
    expect(taskChoiceState(task({ ...reaper, deliveredReason: null }))).toBe('review-unfinished');
  });

  it('fan-out e sottotask parcheggiati restano fuori: hanno già la loro superficie', () => {
    // Non è timidezza: lì la scelta giusta non è nessuna di queste. Il fan-out
    // si decide dal pannello Tentativi (quale tenere), i figli parcheggiati
    // sono una domanda con le sue due risposte rapide.
    expect(taskChoiceState(task({ ...reaper, deliveredReason: 'fanout' }))).toBe('review-branch');
    expect(taskChoiceState(task({ ...reaper, deliveredReason: 'parked_children' }))).toBe('review-branch');
  });

  it('una consegna col ramo offre anche APPROVA: landare e chiudere non sono la stessa cosa', () => {
    // Il buco misurato il 13/08 su 487ddf94, il cui lavoro sta in un ALTRO repo
    // (`remotion-scenes`): le scelte erano landa / rimanda / serve-a-me, e
    // l'unica cosa da fare — chiuderla — non c'era. «Landa su main» fonde un
    // ramo; su una card cosi' non significa niente.
    //
    // È la stessa regola che questo file gia' pretende per `review-unfinished`:
    // togliere un'uscita a chi decide è l'errore opposto.
    const ids = taskChoices(consegnata).map((c) => c.id);
    expect(ids).toContain('accept');
    expect(ids).toContain('land');
    // Il verde resta il land: su una consegna col ramo il gesto normale è farla
    // atterrare, e «Approva» è l'uscita accanto, non quella in testa.
    expect(taskChoices(consegnata).find((c) => c.id === 'accept')).toMatchObject({ tone: 'neutral' });
  });

  it('coi checks ROSSI la card dice «comunque», come il drawer', () => {
    // The defect: `checksState` was not among the fields the choices are born
    // from, so `acceptOverride` always answered "no exception". The button said
    // «Approva», the drawer on the SAME task said «Approva comunque», and the
    // click took a 409 naming `force: true` at someone who cannot pass it.
    const rossa = task({ ...consegnata, checksState: 'fail' });
    const scelte = byId(rossa);
    expect(scelte.get('accept')!.label).toBe(acceptWord('checks-red').label);
    expect(scelte.get('accept')!.label).not.toBe(taskActionWord('accept').label);
    // Landing CONTAINS the acceptance and merges onto main on top: if
    // «comunque» holds for one of the two, it holds all the more for the other.
    expect(scelte.get('land')!.label).toBe(landWord('checks-red').label);
    expect(scelte.get('land')!.label).not.toBe(taskActionWord('land').label);
    // And the green one is no longer the land: with red checks the normal road
    // is sending the output back. No exit disappears.
    expect(taskChoices(rossa)[0]).toMatchObject({ id: 'send-back', tone: 'primary' });
    expect(taskChoices(rossa).filter((c) => c.tone === 'primary')).toHaveLength(1);
    expect(taskChoices(rossa).map((c) => c.id).sort()).toEqual(taskChoices(consegnata).map((c) => c.id).sort());
  });

  it('coi checks verdi non cambia niente: l\'eccezione è l\'eccezione', () => {
    const verde = task({ ...consegnata, checksState: 'pass' });
    expect(taskChoices(verde).map((c) => c.label)).toEqual(taskChoices(consegnata).map((c) => c.label));
    expect(taskChoices(verde)[0]).toMatchObject({ id: 'land', tone: 'primary' });
  });

  it('il verde non è più «Landa su main»: è la sola uscita che fa avanzare il lavoro', () => {
    expect(taskChoices(consegnata)[0]).toMatchObject({ id: 'land', tone: 'primary' });
    expect(taskChoices(reaper)[0]).toMatchObject({ id: 'send-back', tone: 'primary' });
    expect(taskChoices(reaper).filter((c) => c.tone === 'primary')).toHaveLength(1);
  });

  it('land e accept restano, neutri: a chi decide non si toglie un\'uscita', () => {
    const scelte = byId(reaper);
    expect(scelte.get('land')).toMatchObject({ tone: 'neutral' });
    expect(scelte.get('accept')).toMatchObject({ tone: 'neutral' });
    expect(scelte.get('take-over')).toMatchObject({ tone: 'neutral' });
  });

  it('e non portano le stesse parole: «comunque» dice che è un\'eccezione', () => {
    const scelte = byId(reaper);
    expect(taskChoices(reaper).map((c) => c.label)).not.toEqual(taskChoices(consegnata).map((c) => c.label));
    expect(scelte.get('land')!.label).toBe(landWord('unfinished').label);
    expect(scelte.get('land')!.label).not.toBe(taskActionWord('land').label);
    expect(scelte.get('accept')!.label).toBe(acceptWord('unfinished').label);
    expect(scelte.get('accept')!.label).not.toBe(taskActionWord('accept').label);
    expect(taskChoices(reaper)[0].label).toBe(sendBackWord('unfinished').label);
    expect(taskChoices(reaper)[0].label).not.toBe(taskActionWord('send-back').label);
  });

  it('senza un tab da riprendere la parola torna quella vera', () => {
    // «Rimandalo avanti» prometterebbe una ripresa che non può avvenire: senza
    // agente il task torna In Progress in mano a una persona, e lo dice.
    const orfana = task({ status: 'review', assignedTopicId: null, deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
    expect(taskChoices(orfana)[0].label).toBe(taskActionWord('send-back').label);
    expect(taskChoices(orfana)[0].title).toBe(sendBackWord('human').title);
    // Nessun ramo, nessun merge da offrire.
    expect(ids(orfana)).not.toContain('land');
  });

  it('il tooltip di «Approva comunque» nomina la strada giusta, che qui è un\'altra', () => {
    // Stessa parola sul bottone, due ragioni diverse: coi checks rossi la strada
    // normale è rimandare indietro l'output, qui è farlo continuare. Nominare
    // l'altra manderebbe il reviewer a cercare un bottone che non c'è.
    expect(acceptWord('unfinished').label).toBe(acceptWord('checks-red').label);
    expect(acceptWord('unfinished').title).not.toBe(acceptWord('checks-red').title);
    expect(acceptWord('unfinished').title).toContain(sendBackWord('unfinished').label);
    expect(acceptWord('checks-red').title).toContain(taskActionWord('send-back').label);
  });

  it('nel drawer il verde si sposta, e le tre uscite restano tutte', () => {
    const drawerReaper = drawerTask({ deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
    expect(reviewDecisionButtons(drawerTask()).primary).toBe('accept');
    expect(reviewDecisionButtons(drawerReaper).primary).toBe('send-back');
    const d = reviewDecisionButtons(drawerReaper);
    expect(d.accept.label).toBe(acceptWord('unfinished').label);
    expect(d.sendBack.label).toBe(sendBackWord('unfinished').label);
    expect(d.land!.label).toBe(landWord('unfinished').label);
  });

  it('il de-duplicatore vede le parole DISEGNATE, anche quando cambiano', () => {
    // È la trappola già pagata due volte: il bottone si rinomina e la lista che
    // sottrae i gemelli resta a ieri, quindi la risposta rapida che RIGETTA
    // torna accanto al bottone vero.
    const drawerReaper = drawerTask({ deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
    expect(drawerSurfaceLabels(drawerReaper)).toContain(landWord('unfinished').label);
    expect(drawerSurfaceLabels(drawerReaper)).toContain(sendBackWord('unfinished').label);
    expect(drawerSurfaceLabels(drawerReaper)).not.toContain(taskActionWord('land').label);
    expect(usableQuestionOptions(reaper, ['Landa comunque', 'Sì'], { surfaceLabels: drawerSurfaceLabels(drawerReaper) }))
      .toEqual(['Sì']);
  });

  it('sulla card il chip sta PRIMO nella riga: cambia la decisione, non è una relazione', () => {
    // Fatto di JSX, quindi controllato come gli altri fatti di JSX qui dentro
    // (vedi «no board surface reads an action key behind the table»): il chip
    // «non consegnato» va letto PRIMA di guardare i bottoni, quindi precede i
    // chip di relazione (aspetta, riaperta, il padre).
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.tsx'), 'utf8');
    const chip = src.indexOf('data-testid="card-system-delivered"');
    expect(chip).toBeGreaterThan(-1);
    for (const dopo of ['data-testid="card-blocked-by"', 'data-testid="card-reopened"', 'data-testid="card-waiting-on-this"']) {
      expect(chip, `il chip di sistema deve precedere ${dopo}`).toBeLessThan(src.indexOf(dopo));
    }
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
    // Consegnata DALL'AGENTE: è ciò che rende le sue scelte land/send-back/take-over.
    deliveredBy: 'agent' as const,
    deliveredReason: null,
    // Checks not run: the words stay plain (red turns them into «comunque»).
    checksState: null,
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
    // Da quando la card OFFRE «Approva» fra le sue scelte, il doppione cade da
    // solo: non serve piu' che il drawer dichiari i propri bottoni perche' la
    // risposta rapida identica sparisca. `surfaceLabels` resta la rete per le
    // parole che solo il drawer disegna (es. «Approva comunque» sui check rossi).
    expect(usableQuestionOptions(consegnata, ['Approva'])).toEqual([]);
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

  /**
   * IL GEMELLO CHE LA PAROLA NUOVA HA LASCIATO PASSARE.
   *
   * Misurato su una schermata vera (card a41af39a, 21/08): in cima «Landa su
   * main», sotto quattro bottoni, e fra quelli il land VERO si chiamava «Landa
   * comunque». Due porte allo stesso merge, a mezzo centimetro l'una
   * dall'altra, e chi guarda non ha modo di sapere che sono la stessa.
   *
   * Il buco sta nel confronto: il de-dup sottrae le parole DISEGNATE, e su una
   * card che nessuno ha consegnato quella parola è cambiata («comunque»),
   * mentre l'opzione dell'agente resta la stringa che il server esegue
   * (`LAND_ACTION_LABEL`, per valore, non tradotta). Rinominare il bottone ha
   * quindi riaperto da solo la porta che il de-dup chiudeva — la stessa
   * trappola già pagata due volte, e stavolta l'ha aperta un fix.
   *
   * Quindi il confronto non può guardare solo la parola: deve conoscere anche
   * la stringa RISERVATA dell'azione, che è ciò che l'agente scriverà sempre.
   */
  it('«Landa su main» cade anche quando il bottone vero dice «Landa comunque»', () => {
    const reaper = { ...consegnata, deliveredBy: 'system' as const, deliveredReason: 'retries_exhausted' as const };
    // Precondizione: è proprio il caso in cui la parola sul bottone cambia.
    expect(taskChoices(reaper).find((c) => c.id === 'land')!.label).toBe(landWord('unfinished').label);
    expect(landWord('unfinished').label).not.toBe(LAND_ACTION_LABEL);
    // E il gemello deve sparire lo stesso: stessa porta, stesso merge.
    expect(usableQuestionOptions(reaper, [LAND_ACTION_LABEL])).toEqual([]);
    expect(usableQuestionOptions(reaper, ['🚀 Landa su main'])).toEqual([]);
    // Ma solo quando il land è davvero fra le scelte: senza ramo non c'è
    // nessun bottone sotto, e togliere l'opzione lascerebbe la card muta.
    const senzaRamo = { ...reaper, deliveryBranch: null };
    expect(usableQuestionOptions(senzaRamo, [LAND_ACTION_LABEL])).toEqual([LAND_ACTION_LABEL]);
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
    // Consegnata DALL'AGENTE: è ciò che rende le sue scelte land/send-back/take-over.
    deliveredBy: 'agent' as const,
    deliveredReason: null,
    // Checks not run: the words stay plain (red turns them into «comunque»).
    checksState: null,
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
    const labels = drawerSurfaceLabels(drawerTask(), en);
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

describe('una frase scritta non e\' mai un verdetto', () => {
  // The real failure, not a textbook one: task b673a253, merge commit
  // 8b97e432. Feedback typed in the card's field plus Enter merged the branch
  // into main and closed the task, because Enter ran `scelte[0]` and on a
  // delivery with a branch `scelte[0]` is «Landa su main».
  const withBranch = task({ status: 'review', assignedTopicId: 'top-1', deliveryBranch: 'task/abc', deliveredBy: 'agent' });
  const aMano = task({ status: 'review', assignedTopicId: null, deliveryBranch: null });
  const mai = task({ status: 'review', assignedTopicId: 'top-1', deliveryBranch: 'task/abc', deliveredBy: 'system', deliveredReason: 'retries_exhausted' });

  it('sulla consegna col ramo il testo va indietro all\'agente, non su main', () => {
    expect(taskChoiceState(withBranch)).toBe('review-branch');
    expect(taskChoices(withBranch)[0]?.id).toBe('land');
    expect(choiceForText(taskChoices(withBranch))?.id).toBe('send-back');
  });

  it('sulla review a mano il testo non approva', () => {
    expect(taskChoiceState(aMano)).toBe('review-plain');
    expect(taskChoices(aMano)[0]?.id).toBe('accept');
    // No entry carries text except `redo`, which only wants the focus in the
    // field: so the text stays a note, and decides nothing.
    const scelta = choiceForText(taskChoices(aMano));
    expect(scelta?.id).toBe('redo');
    expect(scelta?.needsText).toBe(true);
  });

  it('dove la prima voce era gia\' giusta non cambia niente', () => {
    expect(taskChoiceState(mai)).toBe('review-unfinished');
    expect(taskChoices(mai)[0]?.id).toBe('send-back');
    expect(choiceForText(taskChoices(mai))?.id).toBe('send-back');
  });

  // The rule is not «drop land from review-branch»: it is «no verdict because
  // of text». It holds on EVERY shape the card can draw, including the ones
  // somebody adds after me.
  it('nessuna forma di card offre un verdetto al testo', () => {
    const forme: ChoiceInput[] = [
      withBranch, aMano, mai,
      task({ status: 'todo' }),
      task({ status: 'in_progress', assignedTopicId: 't', dispatchState: 'working' }),
      task({ status: 'in_progress', assignedTopicId: 't', dispatchState: 'queued' }),
      task({ status: 'todo', blockedByTaskId: 'altro', blockedBy: { status: 'todo', archived: false } as ChoiceInput['blockedBy'] }),
    ];
    for (const f of forme) {
      const scelta = choiceForText(taskChoices(f));
      if (!scelta) continue;
      expect(VERDICT_CHOICES).not.toContain(scelta.id);
    }
  });

  it('senza scelte non inventa niente', () => {
    expect(choiceForText([])).toBeNull();
  });
});
