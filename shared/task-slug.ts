// The DECORATIVE part of a task deep-link: `/task/<title-slug>-<uuid>`.
//
// The taskId is a globally unique UUID and resolves on its own
// (`WHERE id=<uuid>`) — that decision is not reopened here. The slug in front
// of it is pure decoration for the human reading the link in a chat window: it
// is written when the link is built and THROWN AWAY when the link is read.
//
// The whole point is that reading NEVER depends on it. A renamed task, a
// hand-mangled slug, a link truncated by a chat client mid-slug: they all still
// carry the UUID at the end, so they all still open the same task. If the slug
// ever started to matter for resolution it would have stopped being decoration
// and gone back to being addressing, which is exactly what got removed.

/** A UUID, anchored at the END of a path segment: what actually resolves. */
const TRAILING_UUID_RE = /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Longest slug we are willing to put in front of the id. Long enough for a
 *  real title to survive, short enough that the UUID stays visible in a chat
 *  preview that truncates the line. */
const MAX_SLUG_LENGTH = 48;

/**
 * A URL-safe, lowercase slug for a task title, or '' when nothing usable is
 * left (an emoji-only title, an empty one). Accents are folded so the segment
 * needs no percent-encoding and stays readable.
 */
export function taskLinkSlug(title: string | null | undefined): string {
  if (typeof title !== 'string') return '';
  const folded = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!folded) return '';
  if (folded.length <= MAX_SLUG_LENGTH) return folded;
  // Cut on a word boundary when there is one, so the slug does not end on half
  // a word; fall back to a hard cut for a single very long token.
  const cut = folded.slice(0, MAX_SLUG_LENGTH);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/**
 * The path segment of a task deep-link: `<slug>-<taskId>`, or the bare taskId
 * when there is no title to decorate it with (or the id is not a UUID, in which
 * case a prefix could not be told apart from the id on the way back).
 */
export function taskLinkSegment(taskId: string, title?: string | null): string {
  if (!isTaskUuid(taskId)) return taskId;
  const slug = taskLinkSlug(title);
  return slug ? `${slug}-${taskId}` : taskId;
}

/**
 * The taskId inside a deep-link segment: drops everything before the trailing
 * UUID. A segment that does not end in a UUID is returned untouched — ids that
 * are not UUIDs (short test ids, historical keys) are still the whole segment.
 */
export function taskIdFromSegment(segment: string): string {
  const m = TRAILING_UUID_RE.exec(segment);
  return m?.[1] ?? segment;
}

/** True when the string is a plain UUID: only then can a prefix be stripped
 *  without risking eating part of the id itself. */
export function isTaskUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
