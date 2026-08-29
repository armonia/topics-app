/**
 * THE RESTART ATTEMPT, WITHOUT THE COMPONENT AROUND IT.
 *
 * It lives outside `SystemStatusPanel` for one reason: the panel cannot be
 * mounted in a unit test (it polls the server, reads three stores and is drawn
 * in a portal), and the two facts that matter here are behaviour, not markup.
 * A failed restart has to SHOW, and a retry that works has to switch the red
 * band off. Keeping them in an inline `onClick` is what let both slip through.
 *
 * The reset at the start is the whole point of the second fact: the error state
 * used to be set and never cleared except by unmounting, and the dropdown does
 * not unmount when you click inside it. You could retry, succeed, and keep the
 * red band next to a Gateway that had gone green again.
 */

export interface GatewayRestartDeps {
  /** `openclawControlApi.restart`: it THROWS on a refusal, envelope included. */
  restart: () => Promise<unknown>;
  setRestarting: (value: boolean) => void;
  /** `null` clears the band. */
  setError: (message: string | null) => void;
  /** Re-read the status once the gateway has had time to come back. */
  scheduleRefresh: () => void;
}

export async function runGatewayRestart(deps: GatewayRestartDeps): Promise<void> {
  // A new attempt starts from silence: what is on screen is about the previous
  // one and is already out of date the moment the button is pressed again.
  deps.setError(null);
  deps.setRestarting(true);
  try {
    await deps.restart();
    deps.scheduleRefresh();
  } catch (e) {
    deps.setError(e instanceof Error ? e.message : 'Riavvio non riuscito');
  } finally {
    deps.setRestarting(false);
  }
}
