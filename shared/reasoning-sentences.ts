/**
 * Sentence units of a reasoning block, shared by the server (which translates
 * them) and the client (which swaps them in place).
 *
 * Both sides MUST cut the same text the same way: the client finds a
 * translation by the exact trimmed text of the sentence the server sent, so one
 * function owns the cut. `Intl.Segmenter` is in Bun and in every browser the
 * app runs on.
 */

/** Below this many letters a sentence is not worth a translation round trip ("ok.", "Dr."). */
const MIN_LETTERS = 8;

let cutter: Intl.Segmenter | null = null;

/** The raw segments of `text`, whitespace kept, so joining them gives `text` back. */
export function splitSentences(text: string): string[] {
  cutter ??= new Intl.Segmenter(undefined, { granularity: "sentence" });
  const out: string[] = [];
  for (const part of cutter.segment(text)) out.push(part.segment);
  return out;
}

/**
 * Can this sentence be translated at all? It needs some letters and more than
 * one word: a lone path, identifier or number has nothing to translate.
 */
export function isTranslatableSentence(sentence: string): boolean {
  const core = sentence.trim();
  if (!/\s/.test(core)) return false;
  const letters = core.match(/\p{L}/gu)?.length ?? 0;
  return letters >= MIN_LETTERS;
}
