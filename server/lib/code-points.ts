/**
 * The first `max` code points of `s`: exactly what
 * `Array.from(s).slice(0, max).join("")` returns, without first building an
 * array of every character of the string.
 *
 * Code points and not UTF-16 units because that is the unit of SQLite's
 * `substr`, which cuts the same text on the list path (see `previewOf` in
 * `services/tasks.ts`). `Array.from` walks a string by code point: a valid
 * surrogate pair is one step, a lone surrogate is a step of its own. The loop
 * below walks the same way and stops at `max`.
 *
 * Why it exists: the board feed cut every card's 800-character preview with
 * `Array.from`, an 800-entry array per card to keep 240 of them. Profiled on
 * 150 cards (2026-10-08) that was a quarter of `svc.list`.
 */
export function sliceCodePoints(s: string, max: number): string {
  if (!(max > 0)) return "";
  // Never more code points than units: a string this short is already whole.
  if (s.length <= max) return s;
  let end = 0;
  for (let n = 0; n < max && end < s.length; n++) {
    const unit = s.charCodeAt(end);
    const pair = unit >= 0xd800 && unit <= 0xdbff
      && end + 1 < s.length
      && (s.charCodeAt(end + 1) & 0xfc00) === 0xdc00;
    end += pair ? 2 : 1;
  }
  return s.slice(0, end);
}
