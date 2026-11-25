/**
 * The pictures a question carries, as both sides read them.
 *
 * A question about something visual is answered by looking: the agent passes
 * the files it already wrote (`images` on the question, `image` on an option)
 * and the panel draws them. One reader of the reference lives here so the
 * server (existence check, card attachments) and the panel agree on what a
 * reference points at.
 */

/** The most pictures one question carries; the panel is a card, not a gallery. */
export const MAX_QUESTION_IMAGES = 4;

interface QuestionWithImages {
  images?: readonly string[];
  options?: ReadonlyArray<{ image?: string } | string>;
}

/**
 * The file a reference points at: a plain path, a `file://` URL or an
 * `/api/media?path=` link (what the agent copies out of the media route).
 */
export function askImagePath(ref: string): string {
  const raw = ref.trim();
  if (raw.startsWith("file://")) {
    const path = decodeURIComponent(raw.slice("file://".length));
    // `file:///C:/x.png` leaves a slash in front of the drive letter.
    return /^\/[A-Za-z]:[/\\]/.test(path) ? path.slice(1) : path;
  }
  const media = raw.match(/\/api\/media\?(?:.*&)?path=([^&#]+)/);
  if (media) return decodeURIComponent(media[1]!);
  return raw;
}

/** Every picture of a set of questions, question images first, no repeats. */
export function questionImageRefs(questions: readonly QuestionWithImages[]): string[] {
  const seen = new Set<string>();
  for (const q of questions) {
    for (const ref of q.images ?? []) if (ref) seen.add(ref);
    for (const o of q.options ?? []) if (typeof o !== "string" && o.image) seen.add(o.image);
  }
  return [...seen];
}
