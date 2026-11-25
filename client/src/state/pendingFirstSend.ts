/**
 * The first message of a new chat, kept on disk while its topic is being made.
 *
 * Sending clears the composer, and clearing the composer erases the saved
 * draft text. From then until the server answers `POST /api/topics` the message
 * lived only in memory (the staged bubble): an app restart in that window lost
 * it. So `promoteDraft` writes it here BEFORE the request and removes it once
 * the topic exists. If the app restarts in between, the draft pane reads it
 * back into its field (`takePendingFirstSend`), and the person sends again.
 */

const pendingKey = (draftId: string): string => `first-send:${draftId}`;

export function savePendingFirstSend(draftId: string, text: string): void {
  try { localStorage.setItem(pendingKey(draftId), text); } catch { /* storage refused: same loss as before this existed */ }
}

export function clearPendingFirstSend(draftId: string): void {
  try { localStorage.removeItem(pendingKey(draftId)); } catch { /* nothing stored */ }
}

/** The unsent first message of a draft, removed from storage as it is read (the draft text key takes over). */
export function takePendingFirstSend(draftId: string): string {
  try {
    const text = localStorage.getItem(pendingKey(draftId)) ?? '';
    if (text) localStorage.removeItem(pendingKey(draftId));
    return text;
  } catch {
    return '';
  }
}
