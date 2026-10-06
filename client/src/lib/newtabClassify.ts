/**
 * How the new-tab page classifies what was submitted (NEWTAB-ARC-03).
 *
 * Three doors, checked in this order:
 *   1. a command attempt — the text starts with `/name` (one token, no dot,
 *      no second slash): a known name runs as that command, an unknown one
 *      stays a suggestion instead of navigating somewhere surprising;
 *   2. a long text — multiline, or over NEWTAB_FILE_LENGTH characters: the
 *      person is writing, not addressing, so the door is "create a note";
 *   3. anything else — an address under the same rule as the bar above
 *      (`toNavigableUrl`), which is what the page has always promised.
 *
 * The order is the contract: an explicit `/intent` marker wins over length,
 * and a local path (`/Users/x/doc.pdf`, `/file.pdf`) wins over the command
 * reading because it carries a second slash or a dot, which no command has.
 * Pure, so the rule is unit-tested without React.
 */
import { toNavigableUrl } from './browserNavUrl';

/** Past this many characters a text is a note being written, not an address. */
export const NEWTAB_FILE_LENGTH = 500;

export type NewTabSubmitKind = 'url' | 'command' | 'file';

export interface NewTabClassification {
  kind: NewTabSubmitKind;
  /**
   * The url to navigate to (url), the canonical `/name` — or the text as
   * typed for an unknown name (command), the text itself (file).
   */
  value: string;
}

/**
 * A leading `/token` that could be a command: one token, letters/digits/dashes
 * only, no dot, no second slash, then a space or the end. `/status` and
 * `/model x` qualify; `/Users/x`, `/file.pdf` and `/` followed by a path do
 * not, and fall through to the url rule (a local file served by us).
 */
const COMMAND_ATTEMPT = /^\/([a-z0-9-]*)(?=\s|$)/i;

function commandAttemptOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const head = trimmed.split(/\s/, 1)[0] ?? '';
  if (head.includes('/', 1) || head.includes('.')) return null;
  const m = COMMAND_ATTEMPT.exec(trimmed);
  return m ? (m[1] ?? '') : null;
}

/**
 * The canonical `/name` when the text invokes a known command, the text as
 * typed when it attempts an unknown one, null when it is no command attempt
 * at all (a path, a url, prose). `known` carries the leading slash, as
 * `SLASH_COMMANDS` does.
 */
export function matchNewTabCommand(text: string, known: readonly string[]): string | null {
  const token = commandAttemptOf(text);
  if (token === null) return null;
  const lowered = token.toLowerCase();
  const hit = known.some((c) => c.slice(1).toLowerCase() === lowered);
  return hit ? `/${lowered}` : text.trim();
}

/** Multiline, or longer than the note threshold: the "create a note" door. */
export function isLongNewTabText(text: string): boolean {
  return text.includes('\n') || text.length > NEWTAB_FILE_LENGTH;
}

/** The door a submit walks through. Null when there is nothing to submit. */
export function classifyNewTabSubmit(
  text: string,
  knownCommands: readonly string[],
): NewTabClassification | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const command = matchNewTabCommand(trimmed, knownCommands);
  if (command !== null) return { kind: 'command', value: command };
  if (isLongNewTabText(trimmed)) return { kind: 'file', value: trimmed };
  return { kind: 'url', value: toNavigableUrl(trimmed) };
}

/**
 * The file name for the note, from its first line: accents folded, runs of
 * anything that is not a letter or digit collapsed to one dash, capped.
 * `nota` when nothing usable survives (an empty first line, only emoji).
 */
export function slugNewTabNoteName(text: string, maxLen = 40): string {
  const first = text.split('\n', 1)[0] ?? '';
  const slug = first
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'nota';
}
