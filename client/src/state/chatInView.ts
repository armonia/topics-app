/**
 * Which subject the person has in front in THIS window, for the server.
 *
 * An epoch born on a subject in front of a window that is awake is born seen:
 * no number, no unseen history row, no push (ATTN-06). The server can decide
 * that only if each window tells it what it has in front and whether it is
 * awake, so the window declares its focused pane here (`useSeenFocusedPane`,
 * `SubjectInFront`) and `useWebSocket` sends it as the `focus` frame
 * (`{ subject, awake }`) at every change of either, and again after a
 * reconnect.
 *
 * Subjects are the attention keys: `topic:<id>`, `terminal:<id>`.
 */
import { isWindowAwake } from './windowAwake';

/** The holders, in the order they declared: the last one is the subject in front. */
const held: string[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener must not break the others */ }
  }
}

/** Declare `subject` the pane in front of this window until the returned
 *  release runs. A remount can overlap the release: each hold is counted. */
export function holdSubjectInFront(subject: string): () => void {
  const before = subjectInFront();
  held.push(subject);
  if (subjectInFront() !== before) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = held.lastIndexOf(subject);
    if (at === -1) return;
    const was = subjectInFront();
    held.splice(at, 1);
    if (subjectInFront() !== was) notify();
  };
}

/** The subject this window has in front, or null (a browser, a file, nothing). */
export function subjectInFront(): string | null {
  return held.length ? held[held.length - 1] : null;
}

/** Is the person looking at this subject now: held in front AND the window awake. */
export function isSubjectInFront(subject: string): boolean {
  return held.includes(subject) && isWindowAwake();
}

/** Called whenever the subject in front changes. Returns the unsubscribe. */
export function onSubjectInFrontChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
