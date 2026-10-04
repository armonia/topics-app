/**
 * The changeset of a topic (`GET /api/topics/:id/changes/diff`), read only
 * while someone looks at it.
 *
 * WHEN IT READS. Every time the strip's panel opens, and while it stays open
 * every time the list (`useTopicChanges`, re-read at every `stream:end`) is
 * read again. Not only when the list's revisions or counts move: against
 * `HEAD` a line rewritten twice is +1/-1 both times, and in a chat with no card
 * the revisions stay `HEAD`/worktree until someone commits, so the counts said
 * "nothing changed" over a diff that had. The route runs `git diff` once per
 * turn, and only while the panel is open. A `409` from the byte route
 * (`reload`) reads it again too.
 *
 * WHICH ANSWER WINS. The latest request, not the latest response: a slow read
 * started before a turn ended must not overwrite the one started after it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import type { ChangeSet } from '../../../shared/change-set';
import type { TopicChanges } from '../../../shared/topic-changes';

/** What the panel draws: `undefined` = not read yet, `null` = the read failed. */
export type TopicChangeSetState = ChangeSet | null | undefined;

export function useTopicChangeSet(
  topicId: string,
  open: boolean,
  changes: TopicChanges | null,
): { changeSet: TopicChangeSetState; reload: () => void } {
  const [loaded, setLoaded] = useState<{ topicId: string; set: ChangeSet | null } | null>(null);
  const seq = useRef(0);
  // The list the last request was made for, or `null` while the panel is
  // closed: the next open asks again whatever the list says.
  const askedFor = useRef<{ topicId: string; changes: TopicChanges | null } | null>(null);

  const load = useCallback(() => {
    const mine = ++seq.current;
    return apiFetch(`/api/topics/${encodeURIComponent(topicId)}/changes/diff`)
      .then((res) => (res.ok ? (res.json() as Promise<ChangeSet>) : null))
      .catch(() => null)
      .then((set) => {
        if (mine !== seq.current) return;
        setLoaded({ topicId, set });
      });
  }, [topicId]);

  useEffect(() => {
    if (!open) { askedFor.current = null; return; }
    // `useTopicChanges` hands back a new object at every read of the list.
    if (askedFor.current?.topicId === topicId && askedFor.current.changes === changes) return;
    askedFor.current = { topicId, changes };
    void load();
  }, [open, topicId, changes, load]);

  const reload = useCallback(() => { void load(); }, [load]);
  // Another topic's answer is no answer: the previous set stays only for this topic.
  const changeSet = loaded && loaded.topicId === topicId ? loaded.set : undefined;
  return { changeSet, reload };
}
