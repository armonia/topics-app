import { useEffect, useState } from 'react';
import { boardApi, type LandingTicket } from '../../lib/board';
import { landingPolls } from './landingBand';

/**
 * A LANDING TICKET IS FOLLOWED UNTIL IT CLOSES.
 *
 * With nobody asking "and then?", the `202` would be the server's honesty
 * wasted: the request succeeded and the outcome never reaches whoever asked for
 * it. This was the drawer's code, and it lived only there: the card did
 * `await boardApi.land(...)` and dropped the receipt. It is a hook now, so the
 * two surfaces can no longer follow the same ticket in two different ways.
 *
 * @param onSettled called when the round closes, whatever the verdict: that is
 *        the moment to reload the card, because the land may have moved it.
 */
export function useLandingTicket(projectId: string, taskId: string, onSettled: () => void) {
  const [landing, setLanding] = useState<LandingTicket | null>(null);

  useEffect(() => {
    if (!landingPolls(landing)) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const res = await boardApi.landStatus(projectId, taskId);
        if (!alive) return;
        // The same object when nothing changed: otherwise every round would
        // remount this effect and reset the interval.
        setLanding((prev) =>
          prev && prev.phase === res.landing.phase && prev.ahead === res.landing.ahead ? prev : res.landing);
        if (!landingPolls(res.landing)) onSettled();
      } catch {
        // The ticket fell out of the queryable window (or the board is not
        // answering): the band disappears instead of lying.
        if (alive) setLanding(null);
      }
    }, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [landing, projectId, taskId, onSettled]);

  return { landing, setLanding };
}
