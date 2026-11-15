/**
 * Local mirror of a topic's fast-mode bit (`fastMode:<topicId>`). For a draft
 * topic there is no server row, so this write plus the in-memory ref is the
 * only copy until promotion: a failing `setItem` must be seen, not swallowed.
 */
export function cacheFastMode(topicId: string, value: boolean): void {
  try {
    localStorage.setItem(`fastMode:${topicId}`, String(value));
  } catch (e) {
    console.warn('[ChatPane] fastMode could not be cached locally', e);
  }
}
