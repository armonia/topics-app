/**
 * A RED CARD GOES BACK TO ITS AGENT BY ITSELF.
 *
 * A local delivery never reaches review red: the checks gate refuses the PATCH
 * and the agent, still in its turn, reads the output. A delivery from a node
 * does: the branch is planted, the card enters review, and only THEN the bar is
 * measured (`node-delivery-meter.ts`). When that measure came back red nothing
 * moved the card: it sat in review until a person (or a coordinator session)
 * read the red and pressed reject. Measured on 14/11/2026: 7d229fbf red on
 * `gates:fast` for 20 hours in review; in the week before, most of the rejects
 * written by hand said only "CI red" or "CI not measured".
 *
 * A red is not a judgement anybody has to make, so the server makes the move:
 * the card goes back to the agent with the failing command and its log.
 *
 * Two limits keep it from becoming a loop nobody watches:
 *   - the verdict must be about the commit the card delivers now
 *     (`checksCommit === deliveryCommit`): a red of the previous tip is history;
 *   - after `MAX_AUTO_BOUNCES` bounces with no word from a person in between,
 *     the card stays where it is and asks the person. Three rounds that end red
 *     mean the agent cannot get out alone.
 *
 * Pure: no db, no git, no timers. The router reads the card and executes.
 */
import { HUMAN_AUTHOR } from "../../shared/board";

export const MAX_AUTO_BOUNCES = 3;

/** The first words of the note every bounce leaves: it is also how bounces are counted. */
export const RED_BOUNCE_NOTE = "Rimandata da sola all'agente: i check sono rossi";

export interface RedBounceCard {
  status: string;
  archived?: boolean;
  checksState: string | null;
  checksCommit: string | null;
  deliveryCommit: string | null;
  /** A card that asks a person something is that person's, red or not. */
  humanAsk?: string | null;
}

export interface RedBounceComment {
  author?: string | null;
  kind?: string | null;
  content: string;
}

export type RedBounceVerdict =
  | { bounce: true; round: number }
  | { bounce: false; reason: string; exhausted?: boolean };

function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, 40);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

/** Bounces since the last word a person wrote on the card. */
export function bouncesSinceHuman(comments: readonly RedBounceComment[]): number {
  let n = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.author === HUMAN_AUTHOR && (c.kind ?? "comment") === "comment") break;
    if (c.author === "system" && c.content.startsWith(RED_BOUNCE_NOTE)) n += 1;
  }
  return n;
}

export function redBounceVerdict(
  card: RedBounceCard,
  comments: readonly RedBounceComment[],
  opts: { turnLive: boolean },
): RedBounceVerdict {
  const no = (reason: string, exhausted = false): RedBounceVerdict => ({ bounce: false, reason, ...(exhausted ? { exhausted } : {}) });
  if (card.archived) return no("archived");
  if (card.status !== "review") return no("not in review");
  if (card.checksState !== "fail") return no("checks are not red");
  if (!sameCommit(card.checksCommit, card.deliveryCommit)) return no("the red is about another commit");
  if (opts.turnLive) return no("an agent turn is open on the card");
  if ((card.humanAsk ?? "").trim()) return no("the card asks a person something");
  const done = bouncesSinceHuman(comments);
  if (done >= MAX_AUTO_BOUNCES) return no(`${done} bounces already, a person decides`, true);
  return { bounce: true, round: done + 1 };
}

/** What the agent reads when its card comes back: the round and the failing output. */
export function redBounceMessage(round: number, checksComment: string): string {
  return [
    `${RED_BOUNCE_NOTE} (giro ${round} di ${MAX_AUTO_BOUNCES}). Nessuno deve guardarla finché sono rossi.`,
    checksComment,
    "Sistema il rosso nel tuo ramo, committa e rimetti in review con update_task(status=\"review\"). " +
      "Se per uscirne serve una decisione di una persona, dillo con human_ask: solo allora la card aspetta qualcuno.",
  ].join("\n\n");
}
