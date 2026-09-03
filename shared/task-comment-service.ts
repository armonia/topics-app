/**
 * task-comment-service.ts: which rows of a task thread are SERVICE notes.
 *
 * A task thread mixes two things that read the same on screen: the words a
 * human or an agent wrote, and the dispatcher's own bookkeeping (a retry, a
 * server restart, a queue hold, a fan-out that got trimmed). On a busy card the
 * bookkeeping is the majority. So whoever opens the card to DECIDE has to dig
 * for the two or three lines where the agent actually speaks.
 *
 * Measured against the live database as this shipped: 9973 thread rows, 2581 of
 * them bookkeeping, collapsing into 437 folds across 1783 threads - 8275 rows
 * left on screen. On the card the brief was written from, 30 rows become 20.
 * The rest of the wall is `kind='status'` transition history, which is a
 * different thing and stays: see the note on `isServiceComment`.
 *
 * Two rules, in this order, and NEITHER of them is "the machine wrote it":
 *
 *  1. The writer marked it. `kind='service'` is set at the source, by the
 *     dispatcher, which already knows it is not speaking for the agent. This is
 *     the rule that carries every row from here on, so a REWORDED note keeps
 *     folding and a note that loses its mark stops folding.
 *  2. The row carries no mark AND its text is one of the dispatcher's own,
 *     frozen wordings (`LEGACY_DISPATCHER_NOTES`). Thousands of rows in the
 *     database were written before the mark existed and no migration touches
 *     them: they have to keep reading as what they are.
 *
 * Rule 2 is a text match, which is exactly what rule 1 exists to avoid, so it is
 * fenced in on three sides: it only ever sees rows the machine wrote
 * (author='system', kind='comment'), the list is a frozen copy of wordings
 * ALREADY on disk (nobody rewrites a row written last month), and it is
 * POSITIVE - a text nobody recognises stays on screen. The failure mode of a
 * miss is one extra line in the thread, never a hidden one.
 *
 * NO DATE CUT, and that is deliberate. An earlier draft fenced rule 2 behind
 * "written before the mark shipped", with the instant hard-coded to the day the
 * branch was written. That instant is a fuse on a wristwatch: every dispatcher
 * note written between the cut and the deploy is neither marked nor
 * recognisable, and no migration ever goes back for it. Measured on the live
 * database, that is 500 to 800 rows for each day of lag - orphaned
 * forever, in the one direction the fold cannot recover from. Without the cut
 * the two rules agree instead: a wording in this list reads as service whether
 * the row was written last month or a minute ago, so what the thread does is
 * predictable from the text on screen rather than from a deploy date nobody
 * can see. The cost is the mirror image and it is bounded: a NEW note that
 * opens with one of these wordings folds even if its writer forgot the mark -
 * which is what we want, since the writer is the dispatcher and the wording is
 * its own bookkeeping. If a note must stay unfolded, its wording does not
 * belong in this list.
 *
 * That direction is the whole point. 'system' is an author, not a sender: the
 * board writes land/publish/worktree outcomes, pre-review check results and
 * even human decision requests under that same author. A fold keyed on the
 * author would swallow all of them. This one cannot: it folds what it
 * recognises as the dispatcher talking about itself, and shows everything else.
 *
 * Nothing here drops a row. The thread folds a RUN of service notes into one
 * line that opens and shows every one of them, in order: the reason a task sat
 * in the queue stays readable to whoever goes looking for it.
 */

import type { TaskComment } from './board';

/** The author every machine-written note carries. Not a sender: several
 *  different writers share it, which is why it never classifies on its own. */
export const SYSTEM_AUTHOR = 'system';

/** The kind a writer sets to say "this is my own bookkeeping, not speech". */
export const SERVICE_KIND = 'service';

/**
 * The fields the classification looks at. Keeps the module usable from a test
 * (and from the client) without building a whole TaskComment.
 *
 * `createdAt` is NOT one of them, on purpose: a classifier that cannot see the
 * clock cannot grow a date cut back, and a date cut is what orphaned rows the
 * last time round.
 */
export type ThreadComment = Pick<TaskComment, 'author' | 'kind' | 'content'>;

/**
 * Marked at the source: the writer said so. The rule that carries every row
 * from here on, and the reason a reworded note keeps folding.
 *
 * The mark only reaches this function if it survives the trip through the
 * database: `rowToComment` in server/services/tasks.ts whitelists the kinds it
 * hands back, and a kind missing from that list is stored right and READ back
 * as a plain comment, which leaves this rule silently dead. That is guarded by
 * server/services/tasks.comment-kind.test.ts.
 */
export function isMarkedService(c: ThreadComment): boolean {
  return c.kind === SERVICE_KIND;
}

/**
 * The dispatcher's wordings as they sit in the database TODAY, frozen.
 *
 * Read the fencing note at the top of the file before touching this list. Two
 * rules for a new entry: it must be a note the DISPATCHER writes about its own
 * dispatch (not a board action a human asked for, not review evidence, never a
 * question), and it must already exist on disk - every entry below was counted
 * against the live database, and an entry that matches nothing is dead weight
 * that reads like coverage. Anything written from here on carries
 * `kind='service'` instead and never reaches this list.
 *
 * Deliberately absent, and they must stay absent: "Mergiato su main",
 * "Land NON riuscito", "Landato su main ma NON ancora attivo",
 * "Consegnato ma NON su main", "Worktree ... ripulito", "Client ricostruito",
 * "Pubblicato", "Checks pre-review", "Fan-out chiuso" (the attempt comparison
 * the human chooses from) and every question block. Those are outcomes and
 * decisions, and the card is where they are read.
 */
export const LEGACY_DISPATCHER_NOTES: readonly RegExp[] = [
  // Server restarts: the turn picked back up, or the task requeued.
  /^Riavvio del server: ripreso in diretta/,
  /^Ripreso in diretta dopo un riavvio del server/,
  /^Il server (è|e') ripartito/,
  /^Server ripartito a met(à|a') turno/,
  // Another Claude session holding the repo.
  /^Attenzione: c'(è|e') una sessione Claude esterna/,
  /^Attenzione: ci sono \d+ sessioni Claude esterne/,
  // Waiting for a slot, or behind a heavy task.
  /^In coda:/,
  /^In attesa di uno slot/,
  /^Questo task (è|e') PESANTE/,
  // The retry note: the turn ended, the dispatcher goes again on the same
  // session. Keyed on its own TAIL, not on the reason phrase in front, and that
  // is a measurement rather than a preference. The reason phrase
  // (`describeTurnEnd`) also opens two notes that are DECISIONS: the backlog
  // park ("Nessun output dopo N tentativi") and the system delivery to review.
  // On the live database a prefix match on those phrases took 344 + 245 rows of
  // which 586 were retries and 3 were the park decision - so the prefix bought
  // the retries at the price of hiding the only line that says why a card is
  // sitting in backlog. This tail takes 590 retry rows and leaves the
  // decisions on screen.
  / sulla stessa sessione \(tentativo \d+\/\d+[^)]*\)\.$/,
  /^Il turno (è|e') terminato senza arrivare a review/,
  /^Budget dei tentativi finito/,
  // The dispatcher carried the card to review itself once the turns ran out.
  // SINGLE LINE ONLY, and this is the other measured fence: when the agent
  // finished without commenting, this note carries its words recovered from the
  // session after a blank line. 198 such rows on disk, 128 of them carrying
  // recovered words - the only thing the agent said on those cards. A prefix
  // match folds all 198 and buries the speech this fold exists to surface, so
  // the multi-line variant is not service and never folds.
  /^L'agent ha lavorato \d+ turn[^\n]*$/,
  // Dispatch could not start at all.
  /^Auto-dispatch fermato:/,
  /^Task ambiguo o poco specificato/,
  /^Il topic dell'agent precedente non esiste pi(ù|u')/,
];

/**
 * An unmarked machine row whose text the dispatcher owns. Positive by design:
 * an unrecognised machine note stays visible.
 *
 * `createdAt` is deliberately NOT read here. See the note on the date cut at the
 * top of the file: keying this on a hard-coded instant orphans every row written
 * between that instant and the deploy, and makes the same sentence fold or not
 * fold depending on a date the reader cannot see.
 */
export function isLegacyDispatcherNote(c: ThreadComment): boolean {
  if (c.kind !== 'comment' || c.author !== SYSTEM_AUTHOR) return false;
  return LEGACY_DISPATCHER_NOTES.some((re) => re.test(c.content));
}

/**
 * True when this row is the dispatcher talking about itself rather than a human
 * or an agent talking about the work.
 *
 * 'status' rows (transition history) and 'review-note' rows (machine review
 * evidence) are NOT service: each already has its own row in the thread and its
 * own reason to be seen.
 *
 * That is a deliberate limit on the yield, and it is worth saying out loud
 * because it is half the wall: 4406 of the 9973 rows on the live database are
 * 'status', and they also SPLIT runs of bookkeeping, which is why one card ends
 * up with three folds instead of one. Folding them is a separate decision about
 * a separate thing - "who moved this card, when, and why" is the one trail a
 * reopened task has - and it belongs to whoever takes that decision, not to a
 * fold that was asked to hide the dispatcher's chatter.
 */
export function isServiceComment(c: ThreadComment): boolean {
  return isMarkedService(c) || isLegacyDispatcherNote(c);
}

/**
 * THE NOTES THE LAND LEAVES BEHIND on a card that is now closed.
 *
 * NOT service in `isServiceComment`, and the header of this file says why:
 * they are outcomes, and on a card still open they are read where they sit.
 * On a DONE card they are the last words of the thread, above the delivery
 * that says what changed: measured on the last 30 done cards, 9 closed on
 * the "stopped the agent, its work just landed" note. The drawer of a closed
 * card folds them like bookkeeping; every other surface keeps reading them.
 *
 * Same fence as `LEGACY_DISPATCHER_NOTES`: machine author, frozen wordings
 * that exist on disk, positive match.
 */
export const LAND_HYGIENE_NOTES: readonly RegExp[] = [
  /^Fermato l'agente che stava ancora lavorando su questa card/,
  /^Worktree e branch del task ripuliti/,
];

export function isLandHygieneNote(c: ThreadComment): boolean {
  if (c.author !== SYSTEM_AUTHOR) return false;
  if (c.kind !== 'comment' && c.kind !== SERVICE_KIND) return false;
  return LAND_HYGIENE_NOTES.some((re) => re.test(c.content));
}

/** What folds in the thread of a CLOSED card: the bookkeeping, plus the land's hygiene. */
export function isDoneThreadService(c: ThreadComment): boolean {
  return isServiceComment(c) || isLandHygieneNote(c);
}

/** The kind the board writes for a status transition ("chi l'ha spostata"). */
export const STATUS_KIND = 'status';

/**
 * A transition row: the card moved, and this says who moved it and when.
 *
 * NOT service (see `isServiceComment`): the trail of a reopened task is the one
 * thing nobody can reconstruct. But it is also not SPEECH, and on the live
 * database it is 4406 of 9973 rows — the other half of the wall. It is drawn as
 * a chip rather than a paragraph (`StatusTrail`), which is the decision this
 * constant exists to carry.
 */
export function isStatusComment(c: ThreadComment): boolean {
  return c.kind === STATUS_KIND;
}

/** A stretch of adjacent thread rows that are all service, or all not. */
export interface ThreadRun<T> {
  service: boolean;
  comments: T[];
}

/** A stretch of adjacent rows that are all status transitions, or all not. */
export interface StatusRun<T> {
  status: boolean;
  comments: T[];
}

/**
 * Split a run into stretches of adjacent status rows and stretches of
 * everything else. Same contract as `groupServiceRuns`: order preserved,
 * nothing dropped, concatenating the stretches gives back the input.
 *
 * `breaksRun` cuts BEFORE a row for the same reason it does there: the caller
 * marks a gap that holds something of its own, and a chip strip that swallowed
 * the gap would hide it.
 */
export function groupStatusRuns<T extends ThreadComment>(
  comments: readonly T[],
  breaksRun?: (comment: T, index: number) => boolean,
): Array<StatusRun<T>> {
  const runs: Array<StatusRun<T>> = [];
  comments.forEach((c, i) => {
    const status = isStatusComment(c);
    const last = runs[runs.length - 1];
    const cut = i > 0 && !!breaksRun?.(c, i);
    if (last && last.status === status && !cut) last.comments.push(c);
    else runs.push({ status, comments: [c] });
  });
  return runs;
}

/**
 * Split a thread into runs of adjacent service rows and runs of everything
 * else, preserving order and dropping nothing: concatenating the runs gives
 * back the input. Grouping ADJACENT rows (rather than hoisting every service
 * note into one pile at the end) is what keeps the fold in its place in the
 * conversation, so the agent's words stay where they happened.
 *
 * `breaksRun` forces a cut BEFORE a row even when both sides are service: the
 * caller passes "something of mine sits in the gap just before this row", and
 * the wall splits there instead of swallowing it.
 */
export function groupServiceRuns<T extends ThreadComment>(
  comments: readonly T[],
  breaksRun?: (comment: T, index: number) => boolean,
  /** What counts as service here; the default is the thread's own rule. */
  isService: (comment: T) => boolean = isServiceComment,
): Array<ThreadRun<T>> {
  const runs: Array<ThreadRun<T>> = [];
  comments.forEach((c, i) => {
    const service = isService(c);
    const last = runs[runs.length - 1];
    const cut = i > 0 && !!breaksRun?.(c, i);
    if (last && last.service === service && !cut) last.comments.push(c);
    else runs.push({ service, comments: [c] });
  });
  return runs;
}

/** Shortest run worth folding. */
export const FOLD_MIN_RUN = 2;

/**
 * Whether a run collapses into the "N righe di servizio" line.
 *
 * A lone service note does NOT fold: "1 riga di servizio" hides a message
 * without compacting anything, and it costs a click to read one line that was
 * already one line. The fold exists against a WALL of bookkeeping, so it starts
 * where the wall does.
 */
export function foldsAway(run: ThreadRun<unknown>): boolean {
  return run.service && run.comments.length >= FOLD_MIN_RUN;
}
