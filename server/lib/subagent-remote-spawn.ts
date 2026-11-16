/**
 * THE ANDATA LEG of a `spawn_agent` child going to a paired node (SUBAGENT-28:
 * wiring, not a new idea). Every step here is someone else's pure function —
 * `decideRemoteSpawn` (SUBAGENT-25), `snapshotParentAsBundle` (SUBAGENT-26),
 * `pickNodeForChild`/`startRemoteChildRun` (SUBAGENT-27) — this only sequences
 * them and turns "no" at any step into `null`, so the caller's local spawn
 * runs unchanged instead of failing the call.
 */
import { decideRemoteSpawn, type MacOnlyResource } from "./subagent-remote-decision";
import { snapshotParentAsBundle } from "./subagent-bundle";
import { pickNodeForChild, startRemoteChildRun, type ChildNodeCandidate } from "./subagent-remote-run";
import type { CreateRunBody } from "../services/node-client";
import { isPlainBranchName } from "../services/branch-on-origin";

export interface RemoteChildSpawnInput {
  id: string;
  cwd: string;
  prompt: string;
  name: string;
  model: string | null;
  effort: string | null;
  runtime?: "topics" | "claude-code" | null;
  macOnlyResource?: MacOnlyResource | null;
  isGitRepo: boolean;
  /** `git remote get-url origin` of `cwd`, or null when the repo has none yet. */
  originUrl: string | null;
  nodes: readonly ChildNodeCandidate[];
  baseUrlOf: (machineId: string) => string | null;
  tokenOf: (machineId: string) => string | null;
  createRun: (input: { baseUrl: string; token: string; body: CreateRunBody }) => Promise<{ runId: string }>;
}

export type RemoteChildSpawnResult =
  | { ok: true; machineId: string; runId: string; branch: string }
  | { ok: false; reason: string };

/**
 * `null` means this spawn was never a candidate (`decideRemoteSpawn` said no,
 * or there is no origin for a node to find the project by): the caller's
 * local path is what actually runs, this never decided against it.
 */
export async function spawnRemoteChild(input: RemoteChildSpawnInput): Promise<RemoteChildSpawnResult | null> {
  const decision = decideRemoteSpawn({ runtime: input.runtime, isGitRepo: input.isGitRepo, macOnlyResource: input.macOnlyResource });
  if (!decision.remote) return null;
  if (!input.originUrl) return null;
  const node = pickNodeForChild(input.nodes);
  if (!node) return null;
  const branch = `topics-child-${input.id}`;
  if (!isPlainBranchName(branch)) return null;
  const bytes = await snapshotParentAsBundle({ repoPath: input.cwd, snapshotBranch: branch });
  if (!bytes) return null;
  const body: CreateRunBody = {
    originTaskId: input.id,
    originUrl: input.originUrl,
    text: input.prompt,
    description: input.name,
    model: input.model,
    effort: input.effort,
    baseBranch: branch,
    branchBundle: Buffer.from(bytes).toString("base64"),
  };
  const started = await startRemoteChildRun({ node, body, baseUrlOf: input.baseUrlOf, tokenOf: input.tokenOf, createRun: input.createRun });
  if (!started.ok) return { ok: false, reason: started.reason };
  return { ok: true, machineId: node.machineId, runId: started.runId, branch };
}
