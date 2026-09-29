// What a `notification:seen` frame switches off in THIS window.
//
// The server owns the seen-state of chats (unread + rows) and says so with
// `unread:updated`. Two marks live only in each window's memory: a terminal's
// "finished" and a chat's "done". The frame names the subjects it cleared, so
// each window drops those marks too; without this, seeing a terminal's
// notification in one window left its tab lit in every other one.

import { defaultNotificationGroupKey, terminalNotificationGroupKey } from '../../../../shared/notification-log';

export interface SeenFrame {
  /** Group keys cleared (`topic:<id>`, `terminal:<id>`, `task:<id>`). */
  subjects?: string[];
  /** Mark all: everything was seen except these group keys. */
  allExcept?: string[];
}

/** Does this frame cover the subject with this group key? A frame that names
 *  nothing (older servers) is read as covering nothing: the in-memory marks are
 *  then cleared by the gestures that always cleared them. */
export function frameCoversSubject(frame: SeenFrame, groupKey: string): boolean {
  if (frame.allExcept) return !frame.allExcept.includes(groupKey);
  return !!frame.subjects?.includes(groupKey);
}

/** The composers of the two in-memory id spaces, the same ones the rows are
 *  born with: a hand-written `topic:` here would drift from the server's. */
export const terminalSubject = terminalNotificationGroupKey;
export const topicSubject = (topicId: string): string => defaultNotificationGroupKey('topic', topicId) ?? '';

/** The ids in `marked` (terminal session ids, or topic ids) that the frame
 *  switches off, `subjectOf` being that id space's group-key composer. */
export function marksClearedBy(
  frame: SeenFrame,
  subjectOf: (id: string) => string,
  marked: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const id of marked) if (frameCoversSubject(frame, subjectOf(id))) out.push(id);
  return out;
}

/** Should a history row lose its unseen dot on this frame? A legacy frame (no
 *  subjects, no allExcept) is the old "the whole list was seen". */
export function rowSeenByFrame(frame: SeenFrame, groupKey: string | null): boolean {
  if (!frame.subjects && !frame.allExcept) return true;
  if (!groupKey) return !!frame.allExcept;
  return frameCoversSubject(frame, groupKey);
}
