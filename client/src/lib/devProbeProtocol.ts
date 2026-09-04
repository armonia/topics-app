/**
 * The two calls every dev probe makes: am I armed, and here is what I saw.
 *
 * There are three probes in this folder (layout, heap, storage) and they share
 * the same contract on purpose: a flag key in ui-state that must say
 * `{"armed": true}`, one shot (the probe disarms itself so a reload does not
 * start a second run), and a result key written back to ui-state where a curl
 * can read it. Each one carried its own private copy of these two functions,
 * which is how three copies of a fetch stay identical until the day one of them
 * grows a header the others do not have.
 *
 * NEITHER OF THEM EVER THROWS. A probe that breaks the app it is diagnosing is
 * worse than no probe, and the app must not care whether the server answers.
 */

/** True only if the ui-state flag exists and says `{"armed": true}`. */
export async function readProbeFlag(flagKey: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/ui-state/${flagKey}`);
    if (!r.ok) return false;
    const body = (await r.json()) as { value?: { armed?: boolean } };
    return body?.value?.armed === true;
  } catch {
    return false;
  }
}

/** Writes a probe key back to ui-state. Silent when the server does not answer. */
export async function writeProbeState(key: string, value: unknown): Promise<void> {
  try {
    await fetch(`/api/ui-state/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    /* a probe must never make noise when the server does not answer */
  }
}
