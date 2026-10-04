// What a `notification:seen` frame switches off in THIS window: the unseen
// dots of the history rows it names. The lit state of a subject is not here:
// it is the attention state's (`attention:updated`, notifications-redesign).

export interface SeenFrame {
  /** Subjects cleared: group keys (`topic:<id>`, `terminal:<id>`, `task:<id>`),
   *  or the id of a row with no group. */
  subjects?: string[];
}

/** Does this frame cover the subject with this group key? A frame that names
 *  nothing (older servers) is read as covering nothing: the in-memory marks are
 *  then cleared by the gestures that always cleared them. */
export function frameCoversSubject(frame: SeenFrame, groupKey: string): boolean {
  return !!frame.subjects?.includes(groupKey);
}

/** Should a history row lose its unseen dot on this frame? `subjectKey` is the
 *  row's key as the server counts it: its group key, or its own id when it has
 *  no group. A legacy frame (no subjects) is the old "the whole list was seen". */
export function rowSeenByFrame(frame: SeenFrame, subjectKey: string): boolean {
  if (!frame.subjects) return true;
  return frameCoversSubject(frame, subjectKey);
}
