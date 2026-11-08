/**
 * THE SUMMARY: one sentence, two surfaces.
 *
 * ── WHY IT LIVES IN `shared/` AND NOT INSIDE THE DISCORD PIECE ──────────────
 * The same snapshot has to be told in two places: on the Discord profile (the
 * one other people see) and in the status bar at the bottom of the column (the
 * one you see). Writing it twice means that in a month they will say two
 * different things, and the wrong one will be the one you stare at all day.
 * Here there is a single dictionary and a single composition: `buildActivity`
 * uses it to publish, the bar uses it to show.
 *
 * ── WHERE THE TWO SURFACES REALLY PART WAYS ─────────────────────────────────
 * Privacy. On the profile the project name only comes out at the `detailed`
 * step, because there the audience is anyone sharing a server with you. In the
 * bar the audience is you, sitting in front of the machine: there is nothing
 * to hide and the line carries it all. It is a choice of addressee, not two
 * different sentences: the WORDS stay these.
 *
 * ── THE NUMBERS ARE NOT FORMATTED HERE, THEY ARE RECEIVED ───────────────────
 * The one that counts is the server (`computePresenceCounts`), which knows
 * which turns it is streaming and which tasks the board has in hand. This file
 * estimates nothing: it receives the counts and says them.
 */

import type { OutputLanguage } from "./types";

/** The state RIGHT NOW, in exact numbers. The server produces it. */
export interface PresenceCounts {
  /**
   * The open chats: the non-archived topics of this installation.
   *
   * They used to be called «sessioni» in the phrase and «chat» everywhere else  allow-italian: the two competing UI words ARE the subject here
   * in the interface — two words for the same thing, and the wrong one was
   * right in the shop window. Worse: «sessione» is also the name of the  allow-italian: the UI word IS the subject
   * PROCESSES the status bar counts elsewhere, so the same term stood both for
   * the containers and for whoever works inside them.
   */
  openSessions: number;
  /** The ones that are working RIGHT NOW. */
  workingSessions: number;
  /** The tasks the board is running at this moment. */
  activeTasks: number;
  /** The project work is happening on right now. */
  focusProject: string | null;
  /**
   * The Claude sessions open OUTSIDE Topics: a terminal, another harness.
   * They do NOT add up with `openSessions` — that one counts topics, that is
   * containers, and this one counts live processes. A single total would be
   * neither the one nor the other, which is why the phrase names them apart.
   *
   * Optional: a caller that does not know about them must not invent a zero
   * that looks like a measurement.
   */
  externalSessions?: number;
  /**
   * Of the external ones, how many are working right now.
   *
   * It is needed because «4 fuori da Topics» while one of them is grinding  allow-italian: quotes the Italian line the bar renders
   * makes work in progress look idle: it is the same distinction that already
   * exists inside Topics between `openSessions` and `workingSessions`.
   */
  externalWorking?: number;
}

/** The two lines of the card, in the order Discord lays them out. */
export interface PresenceLines {
  /** The top line: who is working, out of how many open sessions. */
  details: string;
  /** The line below: the running tasks, or silence declared out loud. */
  state: string;
}

/** The application name, which is also what gets said when nothing else is
 *  to be said (the `minimal` step). */
export const PRESENCE_APP_NAME = "Topics";

const IT = {
  idle: (n: number) => (n === 1 ? "1 chat aperta" : `${n} chat aperte`),
  working: (w: number, n: number) => `${w} al lavoro · ${n} chat apert${n === 1 ? "a" : "e"}`,
  tasks: (n: number) => (n === 1 ? "1 task in corso" : `${n} task in corso`),
  onProject: (p: string) => `su ${p}`,
  external: (n: number) => (n === 1 ? "1 fuori da Topics" : `${n} fuori da Topics`),
  externalWorking: (w: number, n: number) => `${w} al lavoro fuori da Topics (su ${n})`,
  app: PRESENCE_APP_NAME,
  quiet: "Nessun agente al lavoro",
};

const EN = {
  idle: (n: number) => (n === 1 ? "1 chat open" : `${n} chats open`),
  working: (w: number, n: number) => `${w} working · ${n} chats open`,
  tasks: (n: number) => (n === 1 ? "1 task running" : `${n} tasks running`),
  onProject: (p: string) => `on ${p}`,
  external: (n: number) => (n === 1 ? "1 outside Topics" : `${n} outside Topics`),
  externalWorking: (w: number, n: number) => `${w} working outside Topics (of ${n})`,
  app: PRESENCE_APP_NAME,
  quiet: "No agent working",
};

/**
 * The language of the phrases.
 *
 * `auto` is not a language (shared/types.ts): on the profile the audience is
 * nobody's browser, so with no choice made the language spoken is English. The
 * bar passes the interface language ALREADY resolved, so this branch does not
 * concern it.
 */
function dict(lang: OutputLanguage) {
  return lang === "it" ? IT : EN;
}

/** The project name, spoken. Outside the composition because the `detailed`
 *  step puts it in place of the second line, not at the end. */
export function presenceProjectPhrase(project: string, lang: OutputLanguage = "auto"): string {
  return dict(lang).onProject(project);
}

/**
 * The counts, in two lines.
 *
 * The first never says «0 al lavoro»: at rest the news is how many sessions  allow-italian: quotes the Italian line the card renders
 * you have open. The second carries the tasks, and when there are none it
 * declares silence instead of leaving the line empty.
 */
export function presenceLines(counts: PresenceCounts, lang: OutputLanguage = "auto"): PresenceLines {
  const d = dict(lang);
  const working = counts.workingSessions;
  return {
    // The sessions outside Topics go AFTER, kept separate: they are another
    // unit of measure, and adding them up would give a number that answers no
    // question at all.
    details: [
      working > 0 ? d.working(working, counts.openSessions) : d.idle(counts.openSessions),
      counts.externalSessions
        ? (counts.externalWorking
            ? d.externalWorking(counts.externalWorking, counts.externalSessions)
            : d.external(counts.externalSessions))
        : "",
    ].filter(Boolean).join(" · "),
    // «Nessun agente al lavoro» has to look outside TOO: if the first line  allow-italian: quotes the Italian line the card renders
    // says an external session is grinding, the second one cannot declare
    // silence. They used to contradict each other.
    state:
      counts.activeTasks > 0
        ? d.tasks(counts.activeTasks)
        : (working > 0 || (counts.externalWorking ?? 0) > 0)
          ? d.app
          : d.quiet,
  };
}

/**
 * The same summary on ONE line, for the status bar.
 *
 * It is not a third phrase: it is the pieces of `presenceLines` plus the
 * project, joined by the same separator that already divides «al lavoro» from  allow-italian: quotes the Italian pieces the phrase joins
 * «aperte». The `Topics` branch of the second line falls away here: on the  allow-italian: quotes the Italian pieces the phrase joins
 * profile it serves to keep the card from looking half empty, in a bar it
 * would be a word adding nothing next to the window name.
 *
 * `null` means there is nothing to say, and it is the same case in which the
 * presence is CLEARED: no open session and no task. A line announcing
 * «0 sessioni» is taking up space to say that nothing is happening.  allow-italian: quotes the Italian line that would be rendered
 */
export function presenceSummary(counts: PresenceCounts, lang: OutputLanguage = "auto"): string | null {
  if (counts.openSessions <= 0 && counts.activeTasks <= 0) return null;
  const { details, state } = presenceLines(counts, lang);
  const pezzi = [details];
  if (state !== PRESENCE_APP_NAME) pezzi.push(state);
  if (counts.focusProject) pezzi.push(presenceProjectPhrase(counts.focusProject, lang));
  return pezzi.join(" · ");
}
