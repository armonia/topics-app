/**
 * The changeset of a topic (`GET /api/topics/:id/changes/diff`), read only
 * while someone looks at it.
 *
 * WHEN IT READS. When the strip's panel opens, and while it stays open only
 * when the list (`useTopicChanges`, re-read at every `stream:end`) reports
 * other revisions or other counts: the route runs `git diff` and builds a
 * patch, and a turn that wrote nothing changed nothing to draw. A `409` from
 * the byte route (`reload`) reads it again whatever the list says.
 *
 * WHICH ANSWER WINS. The latest request, not the latest response: a slow read
 * started before a turn ended must not overwrite the one started after it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import type { ChangeSet } from '../../../shared/change-set';
import type { TopicChanges } from '../../../shared/topic-changes';

/** What the panel draws: `undefined` = not read yet, `null` = the read failed. */
export type TopicChangeSetState = ChangeSet | null | undefined;

/** What in the list says the changeset may have moved: its revisions and its counts. */
function signatureOf(topicId: string, changes: TopicChanges | null): string {
  if (!changes) return topicId;
  const rows = changes.files.map((f) => `${f.path}:${f.kind}:${f.added ?? ''}:${f.removed ?? ''}`);
  return JSON.stringify([topicId, changes.revs?.base ?? null, changes.revs?.head ?? null, rows]);
}

export function useTopicChangeSet(
  topicId: string,
  open: boolean,
  changes: TopicChanges | null,
): { changeSet: TopicChangeSetState; reload: () => void } {
  const [loaded, setLoaded] = useState<{ topicId: string; set: ChangeSet | null } | null>(null);
  const seq = useRef(0);
  // The signature the last request was made for: the effect asks again only when it moves.
  const requested = useRef<string | null>(null);
  const signature = useMemo(() => signatureOf(topicId, changes), [topicId, changes]);

  const load = useCallback((sig: string) => {
    const mine = ++seq.current;
    requested.current = sig;
    return apiFetch(`/api/topics/${encodeURIComponent(topicId)}/changes/diff`)
      .then((res) => (res.ok ? (res.json() as Promise<ChangeSet>) : null))
      .catch(() => null)
      .then((set) => {
        if (mine !== seq.current) return;
        // A failed read is asked again on the next open, not left as the answer.
        if (!set) requested.current = null;
        setLoaded({ topicId, set });
      });
  }, [topicId]);

  useEffect(() => {
    if (open && requested.current !== signature) void load(signature);
  }, [open, signature, load]);

  const reload = useCallback(() => { void load(signature); }, [load, signature]);
  // Another topic's answer is no answer: the previous set stays only for this topic.
  const changeSet = loaded && loaded.topicId === topicId ? loaded.set : undefined;
  return { changeSet, reload };
}
