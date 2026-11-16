/**
 * `stop_agent` on a child whose run lives on a paired node (sottoagenti-nodo,
 * trace 4): the node holds the real process, so stopping the child here
 * means `cancelRun` there, not killing a local PTY that does not exist.
 *
 * Injected, not imported: `node-client.ts`'s `NodeClient` is the real shape,
 * but this file only names the one call it needs, so the route can hand in
 * the real client and a test a fake one with no network at all.
 */
export interface StopRemoteChildInput {
  machineId: string;
  runId: string;
  /** The node's address, `null` when the machine was unpaired since the child started. */
  baseUrlOf: (machineId: string) => string | null;
  /** The device token this machine holds for it, `null` the same way. */
  tokenOf: (machineId: string) => string | null;
  cancelRun: (input: { baseUrl: string; token: string; runId: string }) => Promise<void>;
}

export type StopRemoteChildResult = { ok: true } | { ok: false; reason: string };

/**
 * Cancels the run on the node. `ok: false` when there is no address or token
 * to reach it with, or the node did not answer: the caller still marks the
 * child `stopped` on this side either way, so this never throws: a child the
 * person asked to stop must read as stopped locally even when the far end
 * could not be told.
 */
export async function stopRemoteChild(input: StopRemoteChildInput): Promise<StopRemoteChildResult> {
  const baseUrl = input.baseUrlOf(input.machineId);
  const token = input.tokenOf(input.machineId);
  if (!baseUrl || !token) return { ok: false, reason: "node address or token unavailable" };
  try {
    await input.cancelRun({ baseUrl, token, runId: input.runId });
  } catch (err) {
    return { ok: false, reason: `cancel on the node failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}
