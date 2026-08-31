import { useState } from 'react';
import { friendsApi, type FriendshipState } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { friendshipButtons, friendshipNoteKey, type FriendshipAction } from './friendshipActions';

/**
 * THE FRIENDSHIP, on somebody else's profile.
 *
 * It is a strip of its own and NOT a second button next to Follow, because the
 * two are different relations and the moment they sit side by side they read as
 * two strengths of the same one. A follow is "I read you" and takes effect on
 * its own; a friendship is "we know each other" and has to be answered by
 * somebody else. The strip says which of the two is waiting, and on whom.
 *
 * WHY THE STATE IS KEPT HERE AND NOT REFETCHED. Every mutation answers with the
 * state it produced, so the button after the click is drawn from the answer.
 * Refetching the whole profile would work too and would be one round trip to
 * redraw one word.
 *
 * A REFUSED GESTURE IS NOT A CRASH. The server says 409 when the rule already
 * decided (asking again after a refusal, answering a request that has been
 * withdrawn in the meantime). That is a stale screen, not an error to shout
 * about: the strip goes back to what the server says the state really is.
 */
export function FriendshipBar({ personId, initial }: { personId: string; initial: FriendshipState }) {
  const t = useT();
  const [state, setState] = useState<FriendshipState>(initial);
  const [busy, setBusy] = useState(false);

  const run = async (action: FriendshipAction) => {
    if (busy) return;
    setBusy(true);
    try {
      const call = action === 'request' ? friendsApi.request
        : action === 'accept' ? friendsApi.accept
        : action === 'decline' ? friendsApi.decline
        : friendsApi.cancel;
      const { state: next } = await call(personId);
      setState(next);
    } catch {
      // The rule refused it, or the network did. Either way the truth is on the
      // server: ask it once, and if even that fails leave the strip as it is
      // rather than invent a state.
      try {
        const { friends, incoming, outgoing } = await friendsApi.list();
        const has = (l: { id: string }[]) => l.some((p) => p.id === personId);
        setState(has(friends) ? 'friends' : has(incoming) ? 'pending_in' : has(outgoing) ? 'pending_out' : 'none');
      } catch { /* keep what is on screen */ }
    } finally {
      setBusy(false);
    }
  };

  const noteKey = friendshipNoteKey(state);

  return (
    <div data-testid="friendship-bar" data-state={state} className="flex flex-wrap items-center gap-2">
      {noteKey && (
        <span data-testid="friendship-note" className="text-[12.5px] text-app-text-secondary">
          {t(noteKey)}
        </span>
      )}
      {friendshipButtons(state).map((b) => (
        <button
          key={b.testId}
          type="button"
          disabled={busy}
          onClick={() => void run(b.action)}
          data-testid={b.testId}
          className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-60 coarse:min-h-11 ${
            b.tone === 'primary'
              ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
              : 'border-app-border text-app-text hover:bg-app-hover'
          }`}
        >
          {t(b.labelKey)}
        </button>
      ))}
    </div>
  );
}
