/**
 * HOW MANY COMPUTERS ARE WAITING FOR AN ANSWER from this one.
 *
 * Two rows of the user menu say it: «Devices» (a line at the top of its level)
 * and «Nodes» (a badge on the row, because a request needs an answer and the
 * badge is what draws the eye). One reader, so the two cannot count differently.
 * `0` for a guest: the route is owner-only and a 403 means it is not theirs.
 */
import { delegatedRequests, listLocalDelegatedRequests } from '../components/Settings/delegatedMachineAccess';
import { apiFetch } from './shell/net';

export async function pendingRemoteRequests(): Promise<number> {
  try {
    const r = await apiFetch(...listLocalDelegatedRequests());
    if (!r.ok) return 0;
    return delegatedRequests(await r.json()).filter((q) => q.state === 'pending').length;
  } catch {
    return 0;
  }
}
