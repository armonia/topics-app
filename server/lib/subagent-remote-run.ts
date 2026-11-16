/**
 * The child lane of a `spawn_agent` run on a paired node (sottoagenti-nodo,
 * traces 2 and 4): which node takes the child, and the call that starts its run.
 * Kept out of `task-dispatcher-remote-node.ts`, which is the CARD lane and sits
 * at its size ceiling: a child shares the wire (`createRun`) and nothing else.
 */
import type { CreateRunBody } from "../services/node-client";

/**
 * A paired node, as the CHILD lane (sottoagenti-nodo, trace 2) needs to know
 * it to pick a seat: not the card-only shape `OverflowMachine` carries (no
 * cloud lane for a `spawn_agent` child, no RAM clamp — a child weighs a few
 * tens of MB, not a card's GB), just a slot count and how many are already
 * taken.
 */
export interface ChildNodeCandidate {
  machineId: string;
  name: string;
  online: boolean;
  /** Declared capacity (`machines.slots`). */
  slots: number;
  /** Children already running there, this one not counted yet. */
  load: number;
}

/**
 * Where an ELIGIBLE child goes (sottoagenti-nodo, trace 2): the first online
 * node with a free seat on `machines.slots`, else `null` meaning the Mac —
 * the same schema `isRemoteTask`/the overflow lane use for a card (a free
 * seat beats a wait), reduced to what a child needs and nothing else.
 *
 * Eligibility itself (is this child's `cwd` a git repo? does it need a
 * mac-only resource?) is NOT this function's question: that is
 * `decideRemoteSpawn` (sottoagenti-nodo, trace 1, a sibling card not yet
 * landed on main) — this picks a SEAT, given the caller already said yes.
 * Callers inject that decision; this file never imports it.
 */
export function pickNodeForChild(nodes: readonly ChildNodeCandidate[]): ChildNodeCandidate | null {
  return nodes.find((n) => n.online && n.load < n.slots) ?? null;
}

export type StartRemoteChildRunResult = { ok: true; runId: string } | { ok: false; reason: string };

/**
 * STARTS THE CHILD'S RUN on the node `pickNodeForChild` picked: `POST
 * /api/nodes/runs` (`node-client.ts#createRun`), the same door a card's
 * remote launch already uses.
 *
 * `body` is handed in whole, not built here: it carries the git transport
 * (`branchBundle`/`baseBranch`, sottoagenti-nodo trace 3, a sibling card not
 * landed yet) and this file never imports that either — same discipline as
 * `pickNodeForChild` not importing the eligibility decision.
 */
export async function startRemoteChildRun(input: {
  node: ChildNodeCandidate;
  body: CreateRunBody;
  baseUrlOf: (machineId: string) => string | null;
  tokenOf: (machineId: string) => string | null;
  createRun: (input: { baseUrl: string; token: string; body: CreateRunBody }) => Promise<{ runId: string }>;
}): Promise<StartRemoteChildRunResult> {
  const baseUrl = input.baseUrlOf(input.node.machineId);
  const token = input.tokenOf(input.node.machineId);
  if (!baseUrl || !token) return { ok: false, reason: "node address or token unavailable" };
  const { runId } = await input.createRun({ baseUrl, token, body: input.body });
  return { ok: true, runId };
}

