/**
 * comment-author.ts — who spoke, turned into something a person can read.
 *
 * `task_comments.author` is an IDENTITY, written once and kept forever. What
 * goes on a card is a LABEL, and the two are not the same string. Conflating
 * them is what broke: the agent surface used to sign a comment with the topic
 * NAME, and a dispatched agent's topic name is the task title cut at 60
 * characters (`task-dispatcher.ts`: `name: task.text.slice(0, 60)`). So the
 * card tooltip, which prints `author: content`, opened with half a word:
 *
 *   Girare la barra viva della soglia di compattazione: due brac: ...
 *
 * The writer now stores `agent:<topicId>`, the same shape the status row has
 * always used. This module is the READER, and it exists because 404 distinct
 * authors on the live board are already sentences. They cannot be rewritten:
 * a migration file applies itself to the live database within seconds of being
 * created, and this defect is not worth that risk. So the rows stay, and the
 * label is derived every time they are read.
 *
 * THE RULE, and it is a shape test, not a guess:
 *   1. a reserved role (`user`, `system`, `dispatcher`, `verifier`) is itself;
 *   2. `agent:<id>` becomes `agent <first 8 of id>`, the same short id the
 *      board already prints on a task chip;
 *   3. anything else is free text, and it is shown only when it READS as a
 *      name: one line, at most AUTHOR_NAME_MAX_WORDS words, at most
 *      AUTHOR_NAME_MAX_CHARS characters. Otherwise it is a phrase, and a phrase
 *      is not a speaker, so the label falls back to the generic agent.
 *
 * Rule 3 keeps real names ("Claude Code", "native-browser-pane-web") and drops
 * sentences ("Aggiungi filtri sulla board Kanban"). It cannot separate a
 * one-word title ("Test") from a one-word name, and it does not try to: a short
 * token above a comment is harmless, a mangled sentence is the bug.
 *
 * Pure by construction: one string in, one record out. No clock, no database.
 */

/** The prefix that marks an author as an agent identity rather than a name. */
export const AGENT_AUTHOR_PREFIX = 'agent:';

/** The generic agent: no id known, or the stored author was not a name. */
export const AGENT_AUTHOR = 'agent';

/**
 * How much of an agent id reaches the eye. Eight characters is what the board
 * already uses to make a task id recognisable (`shortId` in `board.ts`), so an
 * agent and a card are read at the same glance width.
 */
export const AGENT_ID_SHORT_CHARS = 8;

/**
 * A name fits in a label slot. Above this it is prose, whatever it says. The
 * number is the width of the widest thing we are willing to print where a
 * speaker's name belongs, and it is well under the 59-60 characters that every
 * stored task title lands on.
 */
export const AUTHOR_NAME_MAX_CHARS = 24;

/**
 * A name is a token or a short run of tokens. Past three words it is a sentence
 * fragment, and the live board proves it: every stored author with four or more
 * words is a task title.
 */
export const AUTHOR_NAME_MAX_WORDS = 3;

/** The roles the board writes itself. Each one means something to the reader. */
export const RESERVED_AUTHORS = ['user', 'system', 'dispatcher', 'verifier'] as const;

export type ReservedAuthor = (typeof RESERVED_AUTHORS)[number];

/** A reserved role, or `agent` for anything that speaks on an agent's behalf. */
export type CommentAuthorKind = ReservedAuthor | 'agent';

export interface CommentAuthorLabel {
  /** Which surface spoke. Drives styling, never the printed text. */
  kind: CommentAuthorKind;
  /** What to print. Never empty, never a sentence, never cut mid-word. */
  label: string;
  /** The agent identity when the author carried one, else null. */
  agentId: string | null;
  /** True when `label` is not the stored author verbatim. */
  derived: boolean;
}

/** Is this string one of the roles the board writes for itself? */
function reservedAuthor(trimmed: string): ReservedAuthor | null {
  const lower = trimmed.toLowerCase();
  return (RESERVED_AUTHORS as readonly string[]).includes(lower) ? (lower as ReservedAuthor) : null;
}

/**
 * Does this free text read as a name? One line, few words, short. The three
 * conditions are independent and any one of them is enough to reject: a single
 * 40-character token is as unreadable as four short words.
 */
function looksLikeName(trimmed: string): boolean {
  if (!trimmed || trimmed.length > AUTHOR_NAME_MAX_CHARS) return false;
  if (/[\n\r]/.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= AUTHOR_NAME_MAX_WORDS;
}

/**
 * The display record for a stored `task_comments.author`.
 *
 * Accepts anything, including null and undefined: this runs on rows written by
 * older code, and a card must not blank out because a column did.
 */
export function commentAuthorLabel(author: string | null | undefined): CommentAuthorLabel {
  const trimmed = typeof author === 'string' ? author.trim() : '';

  const role = reservedAuthor(trimmed);
  if (role) return { kind: role, label: role, agentId: null, derived: role !== author };

  if (trimmed.toLowerCase().startsWith(AGENT_AUTHOR_PREFIX)) {
    const id = trimmed.slice(AGENT_AUTHOR_PREFIX.length).trim();
    if (!id) return { kind: 'agent', label: AGENT_AUTHOR, agentId: null, derived: true };
    return {
      kind: 'agent',
      label: `${AGENT_AUTHOR} ${id.slice(0, AGENT_ID_SHORT_CHARS)}`,
      agentId: id,
      derived: true,
    };
  }

  if (looksLikeName(trimmed)) {
    return { kind: 'agent', label: trimmed, agentId: null, derived: trimmed !== author };
  }
  return { kind: 'agent', label: AGENT_AUTHOR, agentId: null, derived: true };
}

/**
 * Did an agent write this, as opposed to the board itself or a person? The one
 * predicate several call sites were spelling out inline as a chain of `!==`.
 */
export function isAgentAuthor(author: string | null | undefined): boolean {
  return commentAuthorLabel(author).kind === 'agent';
}
