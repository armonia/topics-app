import type { JobState } from '../../kit';
import type { JobViewModel } from '../../../../ui/programs/model';

/** A job of the container as the components draw it. */
export function jobView(j: JobState | undefined): JobViewModel | undefined {
  if (!j) return undefined;
  return { title: j.title, progress: j.progress, current: j.current, status: j.status, done: j.done, failed: j.failed };
}

/** Every word of `query` appears somewhere in `hay`, accents and case ignored. */
export function matchesAll(hay: string, query: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const h = fold(hay);
  return fold(query).split(/\s+/).filter(Boolean).every((w) => h.includes(w));
}

/** A short code for a PC to be linked, the same for the same name. */
export function linkCode(name: string): string {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 46656;
  const s = h.toString(36).toUpperCase().padStart(3, '0');
  return `${s.slice(0, 3)}-${((h * 7) % 1296).toString(36).toUpperCase().padStart(2, '0')}${(h % 9) + 1}`;
}
