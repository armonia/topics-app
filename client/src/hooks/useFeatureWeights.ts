/**
 * THE INVENTORY READY TO BE SHOWN, joined from the two sources.
 *
 * ON DEMAND, NEVER ON A TIMER. `attivo` is true only while somebody is
 * actually looking: the mouse over the total, or the dropdown open. An
 * inventory recomputing every five seconds with the window sitting still would
 * pay for a serialisation of the whole state to produce a number nobody reads,
 * and that is exactly the kind of work at rest this app has just finished
 * shedding (the 27 writes every 30 seconds, closed on 2026-08-20).
 *
 * The recompute is tied to `sampleKey`: two surfaces open at once on the same
 * sample show the same inventory, instead of two photographs taken a second
 * apart that contradict each other over a message that landed in between.
 */

import { useMemo } from 'react';
import { collectFeatureWeights, ordinaVoci, voceVuota, type VocePeso } from '@/lib/featureWeight';
import { vociMisurate, type IngressiMisurati } from '@/lib/featureUsage';

export function useFeatureWeights(attivo: boolean, misurati: IngressiMisurati, sampleKey?: string): VocePeso[] {
  /* THE INPUTS STAY OUT OF THE DEPENDENCIES, and not inside a ref either.
   *
   * `misurati` is an object literal the caller rebuilds on every render:
   * putting it in the dependency list would redo the count on every render of
   * the parent, which means many times a second while a chat is streaming. And
   * that is precisely what this hook exists to avoid.
   *
   * The value used to travel through a ref written during render: the same
   * thing, but by a route React considers incorrect (a ref read while drawing
   * does not make its reader update). The memo now reads `misurati` directly:
   * when it does recompute it still holds the LATEST value, because the
   * recompute happens during a render and that render carries the fresh input. */
  return useMemo(() => {
    if (!attivo) return [];
    // The two kinds go into the same list and get sorted once: `ordinaVoci`
    // keeps the measured ones in front and never mixes the weighting criteria
    // of one kind with those of another.
    return ordinaVoci([...vociMisurate(misurati), ...collectFeatureWeights()])
      .filter(v => !voceVuota(v));
    /* THE TWO DEPENDENCIES, and why BOTH are needed.
     *
     * `sampleKey` identifies the sample: two surfaces open at once on the same
     * sample show the same inventory, instead of two photographs taken a second
     * apart that contradict each other.
     *
     * `attivo` is the trigger for the SWITCH-ON, and it is not redundant: the
     * bar resamples every 60 seconds, so with `sampleKey` alone anybody moving
     * the mouse over it just after a sample would read an empty tooltip until
     * the next round: a minute of waiting for one line of text. */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the sample, not the object rebuilt on every render
  }, [attivo, sampleKey]);
}
