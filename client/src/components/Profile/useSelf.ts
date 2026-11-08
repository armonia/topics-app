import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonWithProfile } from '@/lib/api';

/**
 * WHO AM I, as the profile surface needs to know it: the whole record, not just
 * a name and a face.
 *
 * `useProfileIdentity` already answers "what do I draw in the corner" and it
 * deliberately returns only a name and an avatar. The profile pages need the
 * id (to ask for their own followers and their own privacy), the counters and
 * the privacy block, so widening that hook would have made every caller of it
 * pay for a shape they do not read. Two hooks, one fetch each, and neither one
 * pretends to be the other.
 *
 * `null` means "not yet" and `ready` means "the round trip is back". The two
 * are not the same thing: a page that treats "not yet" as "nobody" flashes an
 * empty state at every mount, which reads as data loss.
 */
export interface SelfState {
  me: PersonWithProfile | null;
  /** Everybody the server is willing to show me, me included. */
  directory: PersonWithProfile[];
  ready: boolean;
  reload: () => void;
  /** Puts a freshly returned record back in place, without a round trip. */
  update: (p: PersonWithProfile) => void;
}

export function useSelf(): SelfState {
  const [directory, setDirectory] = useState<PersonWithProfile[]>([]);
  const [ready, setReady] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let canceled = false;
    peopleApi.list().then(
      ({ people }) => { if (!canceled) { setDirectory(people); setReady(true); } },
      () => { if (!canceled) { setDirectory([]); setReady(true); } },
    );
    return () => { canceled = true; };
  }, [round]);

  const update = useCallback((p: PersonWithProfile) => {
    setDirectory((cur) => cur.map((x) => (x.id === p.id ? p : x)));
  }, []);

  return {
    me: directory.find((p) => p.isMe) ?? null,
    directory,
    ready,
    reload: useCallback(() => setRound((n) => n + 1), []),
    update,
  };
}
