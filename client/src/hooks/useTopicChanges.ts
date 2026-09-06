/**
 * The files a topic wrote, kept fresh across turns.
 *
 * Split out of the strip that renders it for the reason every fetch in this
 * codebase ends up in a hook: the component would call setState from inside
 * its own effect, which is the cascading-render shape the lint gate refuses.
 * The load is a callback, the effect only fires it.
 *
 * WHEN IT RELOADS. On mount, and at the END of a turn (`stream:end`), never on
 * a token: the endpoint runs git, and asking per chunk would run it dozens of
 * times inside one answer for a list that only changes when the turn is over.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWSSubscription } from './useWSSubscription';
import type { WSMessage } from '../types';
import type { TopicChanges } from '../../../shared/topic-changes';

export function useTopicChanges(
  topicId: string,
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): TopicChanges | null {
  const [changes, setChanges] = useState<TopicChanges | null>(null);

  // A promise chain and not `await`: the state lands in a `.then`, which is the
  // shape the rest of the hooks here use and the one the lint gate reads as
  // "state arriving from outside" rather than a cascading render.
  const load = useCallback(
    () =>
      fetch(`/api/topics/${topicId}/changes`)
        .then((res) => (res.ok ? (res.json() as Promise<TopicChanges>) : null))
        .then((body) => { if (body) setChanges(body); })
        .catch(() => {
          // A list that cannot load is a list that is not there: the chip keeps
          // the count it had and the chat is unaffected.
        }),
    [topicId],
  );

  useEffect(() => { void load(); }, [load]);

  useWSSubscription(onWSMessage, 'stream:end', (msg) => {
    if (msg.topicId && msg.topicId !== topicId) return;
    void load();
  });

  return changes;
}
