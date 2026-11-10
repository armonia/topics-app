import { Fragment } from 'react';

/** The text folded one character at a time, so every folded index maps back to the character it came from. */
function fold(text: string): { folded: string; at: number[] } {
  let folded = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const f = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    folded += f;
    for (let k = 0; k < f.length; k += 1) at.push(i);
  }
  return { folded, at };
}

/** The ranges of `text` that hold any of `words` (already folded: no accents, lower case), accents and case ignored, overlapping ones joined. */
function markRanges(text: string, words: readonly string[]): Array<[number, number]> {
  if (!text || !words.length) return [];
  const { folded, at } = fold(text);
  const found: Array<[number, number]> = [];
  for (const w of words) {
    if (!w) continue;
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + w.length)) found.push([at[i], at[i + w.length - 1] + 1]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const r of found) {
    const last = joined[joined.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else joined.push([r[0], r[1]]);
  }
  return joined;
}

/**
 * A text with the words that were searched for set in `<mark>`: the colour of
 * the design system, not the yellow of the browser. Accents and case are
 * ignored, so `citta` marks `Città`. `words` come folded from the search. allow-italian: quotes the words on screen
 */
export function Marked({ text, words }: { text: string; words: readonly string[] }) {
  const ranges = markRanges(text, words);
  if (!ranges.length) return <>{text}</>;
  const parts: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (const [a, b] of ranges) {
    if (a > from) parts.push({ text: text.slice(from, a), hit: false });
    parts.push({ text: text.slice(a, b), hit: true });
    from = b;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p.hit ? <mark className="rounded-[3px] bg-primary/20 px-px font-medium text-inherit">{p.text}</mark> : p.text}
        </Fragment>
      ))}
    </>
  );
}
