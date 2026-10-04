/**
 * Revision 2026-10-04 §3.3-3.4: the key that makes the same model served by
 * different engines ONE row, and the family/version rule that sorts the ids no
 * engine declares a generation for.
 *
 * The key is conservative on purpose: a false negative leaves two rows in the
 * right column, it never merges two different models.
 */
import { bareModelId } from './modelMaker';

const DATE8 = /^\d{8}$/;
const TAIL = /\[[^\]]*\]$/;

/** runtime prefix and `vendor/` off, lower-case, `:latest` off, `:` and `.`
 *  to `-`, a trailing `-YYYYMMDD` off (before an eventual `[..]`). */
export function mergeKey(id: string): string {
  let m = bareModelId(id);
  const slash = m.indexOf('/');
  if (slash > 0) m = m.slice(slash + 1);
  return m
    .replace(/:latest$/, '')
    .replace(/:/g, '-')
    .replace(/\./g, '-')
    .replace(/-\d{8}(?=\[|$)/, '');
}

/** The family is the key without its first run of bare numbers (at most two);
 *  the version is that run. An id with no bare number has no version. */
export function familyVersion(key: string): { family: string; version: number[] | null } {
  const tail = TAIL.exec(key)?.[0] ?? '';
  const base = tail ? key.slice(0, -tail.length) : key;
  const words = base.split('-').filter((word) => !DATE8.test(word));
  const at = words.findIndex((word) => /^\d+$/.test(word));
  if (at < 0) return { family: base + tail, version: null };
  let end = at;
  while (end < words.length && end - at < 2 && /^\d+$/.test(words[end]!)) end++;
  const version = words.slice(at, end).map(Number);
  const family = words.slice(0, at).concat(words.slice(end)).join('-') + tail;
  return { family, version };
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}
