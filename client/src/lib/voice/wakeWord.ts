/**
 * The activation phrase — just the pure function that recognizes it inside a
 * transcript, no dedicated recognition engine.
 *
 * In `wake-word` mode the mic stays on at low commitment (continuous Web
 * Speech) instead of opening on its own after every announcement: this
 * module decides whether a heard phrase COUNTS — i.e. contains the phrase —
 * and what is left to classify after stripping it. There is no dedicated
 * wake-word engine (Porcupine and the like): on top of the existing infra
 * (`useSpeechToText`, free, in-browser) this is the reasonable boundary,
 * consistent with the rest of the task reusing what already exists.
 */

export const DEFAULT_WAKE_PHRASE = 'hey topics';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents so accented/plain variants match the same
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `null` if the activation phrase is not there. Otherwise the text that
 * follows it (can be empty: "hey topics" alone opens listening without
 * carrying the reply yet).
 */
export function extractAfterWakePhrase(
  transcript: string,
  wakePhrase: string = DEFAULT_WAKE_PHRASE,
): string | null {
  const normTranscript = normalize(transcript);
  const normPhrase = normalize(wakePhrase);
  if (!normPhrase) return null;
  const idx = normTranscript.indexOf(normPhrase);
  if (idx === -1) return null;
  return normTranscript.slice(idx + normPhrase.length).trim();
}

export function containsWakePhrase(transcript: string, wakePhrase: string = DEFAULT_WAKE_PHRASE): boolean {
  return extractAfterWakePhrase(transcript, wakePhrase) !== null;
}
