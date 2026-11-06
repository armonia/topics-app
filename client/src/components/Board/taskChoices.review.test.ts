/**
 * The review card: what it offers, and the words of its face and its menu.
 *
 * @covers KANBAN-05, KANBAN-07
 */
import { describe, it, expect } from 'bun:test';
import { choiceForText, reviewFaceExclude, reviewMenuExclude, taskChoices, taskChoiceState, usableQuestionOptions, VERDICT_CHOICES, type TaskChoiceId } from './taskChoices';
import { acceptWord, drawerSurfaceLabels, landWord, reviewDecisionButtons, sendBackWord, taskActionWord } from './taskActionWords';
import { LAND_ACTION_LABEL } from '../../lib/board';
import { t as translate, ensureLocaleLoaded } from '../../lib/i18n';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChoiceInput, drawerTask, ids, task } from './taskChoicesFixtures';

await ensureLocaleLoaded('en');

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
    const redChecks = task({ ...consegnata, checksState: 'fail' });
    const scelte = byId(redChecks);
    expect(scelte.get('accept')!.label).toBe(acceptWord('checks-red').label);
    expect(scelte.get('accept')!.label).not.toBe(taskActionWord('accept').label);
    // Landing CONTAINS the acceptance and merges onto main on top: if
    // «comunque» holds for one of the two, it holds all the more for the other.
    expect(scelte.get('land')!.label).toBe(landWord('checks-red').label);
    expect(scelte.get('land')!.label).not.toBe(taskActionWord('land').label);
    // And the green one is no longer the land: with red checks the normal road
    // is sending the output back. No exit disappears.
    expect(taskChoices(redChecks)[0]).toMatchObject({ id: 'send-back', tone: 'primary' });
    expect(taskChoices(redChecks).filter((c) => c.tone === 'primary')).toHaveLength(1);
    expect(taskChoices(redChecks).map((c) => c.id).sort()).toEqual(taskChoices(consegnata).map((c) => c.id).sort());
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
    deliveryFilesChanged: 1,
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
    // A historical option cannot reintroduce an unavailable merge.
    const senzaRamo = { ...reaper, deliveryBranch: null };
    expect(usableQuestionOptions(senzaRamo, [LAND_ACTION_LABEL, 'Continua'])).toEqual(['Continua']);
    const analysis = { ...consegnata, deliveryFilesChanged: 0, deliveryCommit: null };
    expect(usableQuestionOptions(analysis, ['🚀 Landa su main', 'Landa comunque', 'Continua'])).toEqual(['Continua']);
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
    deliveryFilesChanged: 1,
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

  it('an empty analysis cannot regain merge through a translated agent option', () => {
    const analysis = { ...consegnata, deliveryFilesChanged: 0, deliveryCommit: null };
    expect(usableQuestionOptions(analysis, [en('board.action.land'), LAND_ACTION_LABEL, 'Continue'], { t: en })).toEqual(['Continue']);
  });

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

/**
 * The review face and the «…» menu, checked as facts, not as source.
 *
 * Only «Approva» stays on the face; «Rifai così» is in neither place; «Archivia»
 * is in the menu even with a branch. These are the same lists the card passes to
 * the row and the menu, so an exit that moves place turns these tests red.
 */
describe('la review: faccia e menu', () => {
  const withBranch = task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' });
  const aMano = task({ status: 'review' });
  const noDelivery = task({ status: 'review', assignedTopicId: 't' });
  const shown = (t: ChoiceInput, exclude: TaskChoiceId[]) => ids(t, { exclude });

  it('sulla faccia resta solo «Approva», con o senza ramo', () => {
    expect(shown(withBranch, reviewFaceExclude(withBranch))).toEqual(['accept']);
    expect(shown(aMano, reviewFaceExclude(aMano))).toEqual(['accept']);
    expect(shown(noDelivery, reviewFaceExclude(noDelivery))).toEqual(['accept']);
  });

  it('«Archivia» sta nel menu, anche sulle card con un ramo', () => {
    expect(shown(withBranch, reviewMenuExclude(withBranch))).toEqual(['land', 'send-back', 'take-over', 'drop']);
    expect(shown(aMano, reviewMenuExclude(aMano))).toEqual(['drop']);
  });

  it('«Rifai così» non compare né in faccia né nel menu: lo fa il campo', () => {
    for (const t of [withBranch, aMano, noDelivery]) {
      expect(shown(t, reviewFaceExclude(t))).not.toContain('redo');
      expect(shown(t, reviewMenuExclude(t))).not.toContain('redo');
    }
  });

  it('nessuna uscita sparisce: faccia e menu coprono tutte le scelte della card', () => {
    for (const t of [withBranch, aMano, noDelivery]) {
      const allIds = ids(t).filter((id) => id !== 'redo');
      const faceAndMenu = [...shown(t, reviewFaceExclude(t)), ...shown(t, reviewMenuExclude(t))];
      expect(faceAndMenu.sort()).toEqual([...allIds].sort());
    }
  });
});
