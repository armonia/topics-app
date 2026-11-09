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
 * A REVIEW BROUGHT BY THE SYSTEM IS NOT A DELIVERY.
 *
 * The defect, measured on 13/08 on two real cards: 5472e584 had been delivered,
 * c0849d9d had ended in review with its turn exhausted, and on the board they
 * were indistinguishable. Not only in appearance: in the CHOICES. Both carried a
 * green "Land on main" on the card and a green "Approve" in the drawer, that is
 * the two actions that close, offered as recommended on a card with nothing
 * behind it. The "not delivered" chip existed since 29/07 and said the right
 * thing, but it lived next to buttons that said the opposite.
 *
 * This block holds the distinction where it counts: in the STATE, in the WORDS
 * and in the TONE. Removing `isUnfinishedReview` from `taskChoiceState` turns it red.
 */
describe('review brought by the system: the choices are not those of a delivery', () => {
  const delivered = task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'topics/x', deliveredBy: 'agent' });
  const reaper = task({ ...delivered, deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
  const byId = (t: ChoiceInput) => new Map(taskChoices(t).map((c) => [c.id, c]));

  it('a parità di ramo e di agente, lo stato è un altro', () => {
    expect(taskChoiceState(delivered)).toBe('review-branch');
    expect(taskChoiceState(reaper)).toBe('review-unfinished');
    // The model that refuses, and the system delivery with no written cause.
    expect(taskChoiceState(task({ ...reaper, deliveredReason: 'model_refused' }))).toBe('review-unfinished');
    expect(taskChoiceState(task({ ...reaper, deliveredReason: null }))).toBe('review-unfinished');
  });

  it('fan-out e sottotask parcheggiati restano fuori: hanno già la loro superficie', () => {
    // It is not shyness: here the right choice is none of these. The fan-out
    // is decided from the Attempts panel (which one to keep), the parked children
    // are a question with its two quick answers.
    expect(taskChoiceState(task({ ...reaper, deliveredReason: 'fanout' }))).toBe('review-branch');
    expect(taskChoiceState(task({ ...reaper, deliveredReason: 'parked_children' }))).toBe('review-branch');
  });

  it('una consegna col ramo offre anche APPROVA: landare e chiudere non sono la stessa cosa', () => {
    // The gap measured on 13/08 on 487ddf94, whose work lives in ANOTHER repo
    // (`remotion-scenes`): the choices were land / send back / take over, and
    // the only thing to do, closing it, was not there. "Land on main" merges a
    // branch; on a card like that it means nothing.
    //
    // It is the same rule this file already demands for `review-unfinished`:
    // removing an exit from whoever decides is the opposite error.
    const ids = taskChoices(delivered).map((c) => c.id);
    expect(ids).toContain('accept');
    expect(ids).toContain('land');
    // Green stays on land: on a delivery with a branch the normal gesture is to
    // land it, and "Approve" is the exit beside it, not the one at the top.
    expect(taskChoices(delivered).find((c) => c.id === 'accept')).toMatchObject({ tone: 'neutral' });
  });

  it('coi checks ROSSI la card dice «comunque», come il drawer', () => {
    // The defect: `checksState` was not among the fields the choices are born
    // from, so `acceptOverride` always answered "no exception". The button said
    // "Approve", the drawer on the SAME task said "Approve anyway", and the
    // click took a 409 naming `force: true` at someone who cannot pass it.
    const redChecks = task({ ...delivered, checksState: 'fail' });
    const choices = byId(redChecks);
    expect(choices.get('accept')!.label).toBe(acceptWord('checks-red').label);
    expect(choices.get('accept')!.label).not.toBe(taskActionWord('accept').label);
    // Landing CONTAINS the acceptance and merges onto main on top: if the
    // "anyway" wording holds for one of the two, it holds all the more for the other.
    expect(choices.get('land')!.label).toBe(landWord('checks-red').label);
    expect(choices.get('land')!.label).not.toBe(taskActionWord('land').label);
    // And the green one is no longer the land: with red checks the normal road
    // is sending the output back. No exit disappears.
    expect(taskChoices(redChecks)[0]).toMatchObject({ id: 'send-back', tone: 'primary' });
    expect(taskChoices(redChecks).filter((c) => c.tone === 'primary')).toHaveLength(1);
    expect(taskChoices(redChecks).map((c) => c.id).sort()).toEqual(taskChoices(delivered).map((c) => c.id).sort());
  });

  it('coi checks verdi non cambia niente: l\'eccezione è l\'eccezione', () => {
    const green = task({ ...delivered, checksState: 'pass' });
    expect(taskChoices(green).map((c) => c.label)).toEqual(taskChoices(delivered).map((c) => c.label));
    expect(taskChoices(green)[0]).toMatchObject({ id: 'land', tone: 'primary' });
  });

  it('il verde non è più «Landa su main»: è la sola uscita che fa avanzare il lavoro', () => {
    expect(taskChoices(delivered)[0]).toMatchObject({ id: 'land', tone: 'primary' });
    expect(taskChoices(reaper)[0]).toMatchObject({ id: 'send-back', tone: 'primary' });
    expect(taskChoices(reaper).filter((c) => c.tone === 'primary')).toHaveLength(1);
  });

  it('land e accept restano, neutri: a chi decide non si toglie un\'uscita', () => {
    const choices = byId(reaper);
    expect(choices.get('land')).toMatchObject({ tone: 'neutral' });
    expect(choices.get('accept')).toMatchObject({ tone: 'neutral' });
    expect(choices.get('take-over')).toMatchObject({ tone: 'neutral' });
  });

  it('e non portano le stesse parole: «comunque» dice che è un\'eccezione', () => {
    const choices = byId(reaper);
    expect(taskChoices(reaper).map((c) => c.label)).not.toEqual(taskChoices(delivered).map((c) => c.label));
    expect(choices.get('land')!.label).toBe(landWord('unfinished').label);
    expect(choices.get('land')!.label).not.toBe(taskActionWord('land').label);
    expect(choices.get('accept')!.label).toBe(acceptWord('unfinished').label);
    expect(choices.get('accept')!.label).not.toBe(taskActionWord('accept').label);
    expect(taskChoices(reaper)[0].label).toBe(sendBackWord('unfinished').label);
    expect(taskChoices(reaper)[0].label).not.toBe(taskActionWord('send-back').label);
  });

  it('senza un tab da riprendere la parola torna quella vera', () => {
    // "Send it on" would promise a resumption that cannot happen: with no agent
    // the task goes back to In Progress in a person's hands, and says so.
    const orphan = task({ status: 'review', assignedTopicId: null, deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
    expect(taskChoices(orphan)[0].label).toBe(taskActionWord('send-back').label);
    expect(taskChoices(orphan)[0].title).toBe(sendBackWord('human').title);
    // No branch, no merge to offer.
    expect(ids(orphan)).not.toContain('land');
  });

  it('il tooltip di «Approva comunque» nomina la strada giusta, che qui è un\'altra', () => {
    // Same word on the button, two different reasons: with red checks the normal
    // road is sending the output back, here it is letting it continue. Naming
    // the other would send the reviewer looking for a button that is not there.
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
    // It is the trap already paid for twice: the button gets renamed and the list
    // that subtracts the twins stays at yesterday's, so the quick reply that
    // REJECTS comes back next to the real button.
    const drawerReaper = drawerTask({ deliveredBy: 'system', deliveredReason: 'retries_exhausted' });
    expect(drawerSurfaceLabels(drawerReaper)).toContain(landWord('unfinished').label);
    expect(drawerSurfaceLabels(drawerReaper)).toContain(sendBackWord('unfinished').label);
    expect(drawerSurfaceLabels(drawerReaper)).not.toContain(taskActionWord('land').label);
    expect(usableQuestionOptions(reaper, ['Landa comunque', 'Sì'], { surfaceLabels: drawerSurfaceLabels(drawerReaper) }))
      .toEqual(['Sì']);
  });

  it('sulla card il chip sta PRIMO nella riga: cambia la decisione, non è una relazione', () => {
    // This is a fact of JSX, so it is checked like the other JSX facts in here
    // (see "no board surface reads an action key behind the table"): the
    // "not delivered" chip has to be read BEFORE the buttons, so it comes before
    // the relation chips (waiting, reopened, the parent).
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.tsx'), 'utf8');
    const chip = src.indexOf('data-testid="card-system-delivered"');
    expect(chip).toBeGreaterThan(-1);
    for (const after of ['data-testid="card-blocked-by"', 'data-testid="card-reopened"', 'data-testid="card-waiting-on-this"']) {
      expect(chip, `il chip di sistema deve precedere ${after}`).toBeLessThan(src.indexOf(after));
    }
  });
});

describe('usableQuestionOptions', () => {
  // A delivered card with a branch: its real choices are
  // land / send back / take over.
  const delivered = {
    deliveryFilesChanged: 1,
    status: 'review' as const,
    assignedTopicId: 'topic-1',
    deliveryBranch: 'topics/x',
    dispatchState: null,
    blockedByTaskId: null,
    blockedBy: null,
    // Delivered BY THE AGENT: this is what makes its choices land/send-back/take-over.
    deliveredBy: 'agent' as const,
    deliveredReason: null,
    // Checks not run: the words stay plain (red turns them into the "anyway" wording).
    checksState: null,
  };

  it('drops an option that collides with a real choice', () => {
    // The measured case (card c57e1aa4): the agent offered the land option as
    // its only option, drawn right above the button that actually merges.
    expect(usableQuestionOptions(delivered, ['Landa su main'])).toEqual([]);
  });

  it('keeps options that are genuinely answers', () => {
    expect(usableQuestionOptions(delivered, ['Sì', 'No, rifai il ritaglio']))
      .toEqual(['Sì', 'No, rifai il ritaglio']);
  });

  it('matches ignoring case, spacing and trailing punctuation', () => {
    expect(usableQuestionOptions(delivered, ['  landa   su MAIN.  ', 'Altro'])).toEqual(['Altro']);
  });

  it('exclude alone looks at the wrong screen, and surfaceLabels fixes it', () => {
    // `exclude` means "not in the choice ROW", which for the drawer is true
    // precisely because it draws that button ITSELF, bigger. Reading exclude
    // alone therefore hid the collision instead of catching it.
    expect(usableQuestionOptions(delivered, ['Landa su main'], { exclude: ['land'] }))
      .toEqual(['Landa su main']);
    expect(usableQuestionOptions(delivered, ['Landa su main'], {
      exclude: ['land'],
      surfaceLabels: [taskActionWord('land').label],
    })).toEqual([]);
  });

  it('«Approva» goes because the drawer draws it, «Approva il piano» stays', () => {
    // The real case (comment 2eff6a44): the card is a review WITH a branch, so
    // its choices are land / send-back / take-over and «Approva» is not among
    // them. The drawer draws it anyway, big: without `surfaceLabels` the
    // identical quick reply survived, and pressing it REJECTED the task.
    const drawn = [taskActionWord('accept').label, taskActionWord('send-back').label, taskActionWord('land').label];
    // Once the card OFFERS "Approve" among its choices, the twin drops by
    // itself: the drawer no longer needs to declare its own buttons for the
    // identical quick reply to vanish. `surfaceLabels` stays the net for the
    // words only the drawer draws (e.g. "Approve anyway" on red checks).
    expect(usableQuestionOptions(delivered, ['Approva'])).toEqual([]);
    expect(usableQuestionOptions(delivered, ['Approva'], { surfaceLabels: drawn })).toEqual([]);
    // "Approve the plan" is ANOTHER thing: an answer to the agent, not the
    // decision button. A de-duplicator that cut this one too would remove the
    // only way to reply.
    expect(usableQuestionOptions(delivered, ['Approva il piano'], { surfaceLabels: drawn }))
      .toEqual(['Approva il piano']);
  });

  it('leaves everything alone when the task has no choices', () => {
    const closed = { ...delivered, status: 'done' as const };
    expect(usableQuestionOptions(closed, ['Landa su main'])).toEqual(['Landa su main']);
  });

  /**
   * THE TWIN THAT THE NEW WORD LET THROUGH.
   *
   * Measured on a real screen (card a41af39a, 21/08): at the top the land
   * option, under four buttons, and among them the REAL land was called "Land
   * anyway". Two doors to the same merge, half a centimetre apart, and whoever
   * looks has no way of knowing they are the same one.
   *
   * The gap is in the comparison: the de-dup subtracts the DRAWN words, and on
   * a card nobody delivered that word has changed ("anyway"), while the agent's
   * option stays the string the server executes (`LAND_ACTION_LABEL`, by value,
   * untranslated). Renaming the button therefore reopened by itself the door the
   * de-dup was closing: the same trap already paid for twice, and this time a
   * fix opened it.
   *
   * So the comparison cannot look only at the word: it must also know the
   * RESERVED string of the action, which is what the agent will always write.
   */
  it('the land option drops even when the real button says "Land anyway"', () => {
    const reaper = { ...delivered, deliveredBy: 'system' as const, deliveredReason: 'retries_exhausted' as const };
    // Precondition: this is exactly the case where the word on the button changes.
    expect(taskChoices(reaper).find((c) => c.id === 'land')!.label).toBe(landWord('unfinished').label);
    expect(landWord('unfinished').label).not.toBe(LAND_ACTION_LABEL);
    // And the twin must vanish all the same: same door, same merge.
    expect(usableQuestionOptions(reaper, [LAND_ACTION_LABEL])).toEqual([]);
    expect(usableQuestionOptions(reaper, ['🚀 Landa su main'])).toEqual([]);
    // A historical option cannot reintroduce an unavailable merge.
    const noBranch = { ...reaper, deliveryBranch: null };
    expect(usableQuestionOptions(noBranch, [LAND_ACTION_LABEL, 'Continua'])).toEqual(['Continua']);
    const analysis = { ...delivered, deliveryFilesChanged: 0, deliveryCommit: null };
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
  const delivered = {
    deliveryFilesChanged: 1,
    status: 'review' as const,
    assignedTopicId: 'topic-1',
    deliveryBranch: 'topics/x',
    dispatchState: null,
    blockedByTaskId: null,
    blockedBy: null,
    // Delivered BY THE AGENT: this is what makes its choices land/send-back/take-over.
    deliveredBy: 'agent' as const,
    deliveredReason: null,
    // Checks not run: the words stay plain (red turns them into the "anyway" wording).
    checksState: null,
  };

  it('an empty analysis cannot regain merge through a translated agent option', () => {
    const analysis = { ...delivered, deliveryFilesChanged: 0, deliveryCommit: null };
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
    expect(usableQuestionOptions(delivered, [LAND_ACTION_LABEL, 'Do something else'], { t: en }))
      .toEqual(['Do something else']);
  });

  it('and it subtracts the ENGLISH word too, for an agent that answers in English', () => {
    expect(usableQuestionOptions(delivered, ['Land on main', 'Do something else'], { t: en }))
      .toEqual(['Do something else']);
  });

  it('the drawer\'s own buttons carry both names', () => {
    const labels = drawerSurfaceLabels(drawerTask(), en);
    expect(labels).toContain('Approve');
    expect(labels).toContain('Approva');
    expect(usableQuestionOptions(delivered, ['Approva', 'Rimanda indietro', 'Qualcos\'altro'], { t: en, surfaceLabels: labels }))
      .toEqual(['Qualcos\'altro']);
  });

  it('a decorated option is the same door: the server thinks so too', () => {
    // `normalizeActionLabel` is the server's own comparison, so the board
    // subtracts exactly what the route would treat as the reserved action.
    expect(usableQuestionOptions(delivered, ['🚀 Landa su main!'], { t: en })).toEqual([]);
  });
});

describe('una frase scritta non e\' mai un verdetto', () => {
  // The real failure, not a textbook one: task b673a253, merge commit
  // 8b97e432. Feedback typed in the card's field plus Enter merged the branch
  // into main and closed the task, because Enter ran `choices[0]` and on a
  // delivery with a branch `choices[0]` is the land choice.
  const withBranch = task({ status: 'review', assignedTopicId: 'top-1', deliveryBranch: 'task/abc', deliveredBy: 'agent' });
  const aMano = task({ status: 'review', assignedTopicId: null, deliveryBranch: null });
  const never = task({ status: 'review', assignedTopicId: 'top-1', deliveryBranch: 'task/abc', deliveredBy: 'system', deliveredReason: 'retries_exhausted' });

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
    const choice = choiceForText(taskChoices(aMano));
    expect(choice?.id).toBe('redo');
    expect(choice?.needsText).toBe(true);
  });

  it('dove la prima voce era gia\' giusta non cambia niente', () => {
    expect(taskChoiceState(never)).toBe('review-unfinished');
    expect(taskChoices(never)[0]?.id).toBe('send-back');
    expect(choiceForText(taskChoices(never))?.id).toBe('send-back');
  });

  // The rule is not "drop land from review-branch": it is "no verdict because
  // of text". It holds on EVERY shape the card can draw, including the ones
  // somebody adds after me.
  it('nessuna forma di card offre un verdetto al testo', () => {
    const forme: ChoiceInput[] = [
      withBranch, aMano, never,
      task({ status: 'todo' }),
      task({ status: 'in_progress', assignedTopicId: 't', dispatchState: 'working' }),
      task({ status: 'in_progress', assignedTopicId: 't', dispatchState: 'queued' }),
      task({ status: 'todo', blockedByTaskId: 'altro', blockedBy: { status: 'todo', archived: false } as ChoiceInput['blockedBy'] }),
    ];
    for (const f of forme) {
      const choice = choiceForText(taskChoices(f));
      if (!choice) continue;
      expect(VERDICT_CHOICES).not.toContain(choice.id);
    }
  });

  it('senza scelte non inventa niente', () => {
    expect(choiceForText([])).toBeNull();
  });
});

/**
 * The review face and the "..." menu, checked as facts, not as source.
 *
 * The face keeps the exits (land first on a delivered branch); the redo quick
 * reply is in neither place; the archive action is only in the menu. These are the
 * same lists the card passes to the row and the menu, so an exit that moves
 * place turns these tests red.
 */
describe('la review: faccia e menu', () => {
  const withBranch = task({ status: 'review', assignedTopicId: 't', deliveryBranch: 'task/abc' });
  const aMano = task({ status: 'review' });
  const noDelivery = task({ status: 'review', assignedTopicId: 't' });
  const shown = (t: ChoiceInput, exclude: TaskChoiceId[]) => ids(t, { exclude });

  it('sulla faccia restano le uscite tranne «Archivia» e «Rifai così»', () => {
    expect(shown(withBranch, reviewFaceExclude(withBranch))).toEqual(['land', 'send-back', 'accept', 'take-over']);
    expect(shown(aMano, reviewFaceExclude(aMano))).toEqual(['accept']);
    expect(shown(noDelivery, reviewFaceExclude(noDelivery))).toEqual(['accept']);
  });

  it('«Archivia» sta solo nel menu, anche sulle card con un ramo', () => {
    expect(shown(withBranch, reviewMenuExclude(withBranch))).toEqual(['drop']);
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
