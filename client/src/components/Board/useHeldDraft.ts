import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftPreview } from './draftPreview';

const HOLD_MS = 8000;

/**
 * The composer's ghost card goes with the typed text, but the created card only
 * arrives with the refetch: without a hold the task sits on no column in
 * between and looks lost. The hold ends when the card is in the feed, or after
 * a few seconds.
 */
export function useHeldDraft(tasks: ReadonlyArray<{ id: string }>) {
  const [typedDraft, setTypedDraft] = useState<DraftPreview | null>(null);
  // The last ghost the composer drew, kept so the column can hold it after the send.
  const lastDraftRef = useRef<DraftPreview | null>(null);
  const [heldDraft, setHeldDraft] = useState<{ id: string; draft: DraftPreview } | null>(null);
  const setDraft = useCallback((next: DraftPreview | null) => {
    if (next) lastDraftRef.current = next;
    setTypedDraft(next);
  }, []);
  const holdCreated = useCallback((taskId: string) => {
    if (lastDraftRef.current) setHeldDraft({ id: taskId, draft: lastDraftRef.current });
  }, []);
  const heldId = heldDraft?.id ?? null;
  const heldArrived = heldId !== null && tasks.some((t) => t.id === heldId);
  useEffect(() => {
    if (heldId === null) return;
    // Once the real card arrives, `draft` below already ignores the held copy.
    if (heldArrived) return;
    const timer = setTimeout(() => setHeldDraft(null), HOLD_MS);
    return () => clearTimeout(timer);
  }, [heldId, heldArrived]);
  const draft = typedDraft ?? (heldDraft && !heldArrived ? heldDraft.draft : null);
  return { draft, setDraft, holdCreated };
}
