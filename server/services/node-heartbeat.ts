/**
 * node-heartbeat.ts — the life signal of a node paired over the network.
 *
 * The local machine writes its own heartbeat and the cloud row is refreshed by the ticker
 * because it exists only where its credentials do. A paired node (the PC behind the ssh
 * tunnel) is neither: it is a server that gets ASKED and never calls. Nobody refreshed its
 * row, so five minutes after the pairing `markStaleOffline` turned it «offline» for good and
 * the device list hid a PC that was up and answering (26/10).
 *
 * The probe asks what the lane already asks: `GET /api/nodes/runs/<id>` with the node's own
 * token. The node authenticates before it looks for the run, so a `not_found` answer proves
 * three things at once, the tunnel carries, the node is up and it still accepts this device,
 * without a run to look at and without a new route (a node built before this change answers
 * it as well). Anything else (refused, timed out, 401/403, 5xx) leaves the row alone and the
 * normal sweep takes it offline after five minutes.
 *
 * It goes through the plain client, NOT through the lane's node-run hook: a probe that woke a
 * sleeping PC every 30 seconds would keep it awake for ever.
 */
import type { Machine } from "../../shared/types";
import type { MachineWorktreeReport } from "../../shared/worktree-summary";
import { isNodeError, type NodeClient } from "./node-client";

/** A run id no node has: the answer we want to this probe is «not found». */
export const PROBE_RUN_ID = "heartbeat-probe";

export interface NodeProbeDeps {
  /** Every machine row; the probe picks the paired nodes itself. */
  list: () => Machine[];
  client: Pick<NodeClient, "readRun"> & Partial<Pick<NodeClient, "readVersion" | "codingModels" | "worktreeSummary">>;
  /** The device token of a node, `null` when this server holds none. */
  tokenOf: (machineId: string) => string | null;
  /** Writes the heartbeat of a node (the row, nothing else) and returns it; `null` when the row is gone. */
  touch: (machineId: string) => Machine | null;
  /**
   * A node answered and its row was refreshed: tell the people looking at the list. Every time, not
   * only on a comeback: the sweep of the same tick may have flipped the row offline after the probe
   * read it, and an announcement decided from that older read would leave the screen saying offline.
   */
  onRefreshed: (machine: Machine) => void;
  isCloud: (baseUrl: string | null) => boolean;
  /** Stores what the node reported about itself (version, models); the probe reads both best-effort. */
  recordReported?: (machineId: string, input: { version?: string | null; models?: string[] | null }) => Machine | null;
  /**
   * Stores the node's worktree summary (T12). A node whose version does not declare
   * `worktreeStandard` is recorded as unsupported and never asked; one whose version could
   * not be read is left as it was.
   */
  recordWorktreeReport?: (machineId: string, report: MachineWorktreeReport) => void;
  log?: (message: string, err?: unknown) => void;
}

/** One probe of every paired node, all at once. Resolves when the last one has answered or failed. */
async function probeOnce(deps: NodeProbeDeps): Promise<void> {
  const nodes = deps.list().filter((m): m is Machine & { baseUrl: string } => !!m.baseUrl && !deps.isCloud(m.baseUrl));
  await Promise.all(nodes.map(async (node) => {
    const token = deps.tokenOf(node.id);
    if (!token) return;
    try {
      await deps.client.readRun({ baseUrl: node.baseUrl, token, runId: PROBE_RUN_ID });
    } catch (err) {
      if (!(isNodeError(err) && err.reason === "not_found")) return;
    }
    try {
      let row = deps.touch(node.id);
      // A node built before these routes answers neither: the row then keeps «unknown», never a guess.
      if (row && deps.recordReported) {
        const [version, models] = await Promise.all([
          deps.client.readVersion?.({ baseUrl: node.baseUrl, token }).catch(() => null),
          deps.client.codingModels?.({ baseUrl: node.baseUrl, token }).catch(() => null),
        ]);
        if (version?.version || models) row = deps.recordReported(node.id, { version: version?.version ?? null, models }) ?? row;
        if (version) await reportWorktrees(deps, node, token, version.worktreeStandard);
      }
      if (row) deps.onRefreshed(row);
    } catch (err) {
      deps.log?.(`nodo: battito di ${node.name} non scritto`, err);
    }
  }));
}

/** The node's worktree summary into its row; a node without the routes is skipped without a call. */
async function reportWorktrees(
  deps: NodeProbeDeps,
  node: Machine & { baseUrl: string },
  token: string,
  supported: boolean,
): Promise<void> {
  if (!deps.recordWorktreeReport) return;
  if (!supported || !deps.client.worktreeSummary) {
    deps.recordWorktreeReport(node.id, { supported: false, summary: null });
    return;
  }
  // The node answers its last measure at once; null until its first one, and then nothing is overwritten.
  const report = await deps.client.worktreeSummary({ baseUrl: node.baseUrl, token }).catch(() => null);
  if (report?.summary) deps.recordWorktreeReport(node.id, { supported: true, summary: report.summary });
}

/**
 * The function the 30-second ticker calls. Rounds never overlap: a tunnel that hangs holds one
 * round, it does not pile one more on top of it every 30 seconds.
 */
export function createNodeProbe(deps: NodeProbeDeps): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void probeOnce(deps)
      .catch((err) => deps.log?.("nodo: sonda dei nodi fallita", err))
      .finally(() => { running = false; });
  };
}
