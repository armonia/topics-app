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
import { longVariantOf, newestOfFamily } from "../providers/claude-models";

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
  /** Override of `MAX_CHILD_BUNDLE_BYTES`, for tests. */
  maxBundleBytes?: number;
  /**
   * The Claude ids the picked node's coding runtimes list (`/api/providers/snapshot` there),
   * null when it cannot be read. Catalogs differ per machine with the CLI installed there
   * (16/11: the cloud node lists `claude-opus-5`, this Mac `claude-opus-5-5`), so an alias
   * is resolved against the node's own list, never this Mac's.
   */
  nodeModels?: (node: { baseUrl: string; token: string }) => Promise<readonly string[] | null>;
}

const MODEL_ALIAS = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i;

/**
 * The model id a node's card accepts for what `spawn_agent` was given. The tool takes the
 * aliases `haiku`, `sonnet`, `opus`, `fable` (with `[1m]`), the node's card wants a full id
 * from its catalog: with `haiku` its dispatcher found no coding agent for the model, failed
 * the launch twice and parked the card, and the child came back lost (16/11, 8 of 8).
 * `undefined` = the node lists no model of that family: it cannot run this child.
 */
export function nodeModelOf(model: string | null, available: readonly string[]): string | null | undefined {
  const m = model ? MODEL_ALIAS.exec(model.trim()) : null;
  if (!m) return model;
  const id = newestOfFamily(m[1]!.toLowerCase(), available);
  if (!id) return undefined;
  return m[2] ? longVariantOf(id, available) : id;
}

export type RemoteChildSpawnResult =
  | { ok: true; machineId: string; runId: string; branch: string }
  | { ok: false; reason: string };

/** Largest parent snapshot a child carries to a node (raw bytes, before base64): 64 MiB. */
export const MAX_CHILD_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * Commits of origin's default a child bundle carries along. A node only fetches origin
 * when one of its own cards needs it, so its checkout runs behind main by the merges of
 * the last hours: a bundle cut at the sender's origin/HEAD then lacks its prerequisites
 * and the node refuses it (16/11: every child to the PC). 200 commits of topics-app are
 * a few MB, well under the cap.
 */
export const CHILD_BUNDLE_MARGIN_COMMITS = 200;

/**
 * `nodeModelOf` against the node's own catalog; `undefined` = this node cannot take the
 * child (no model of that family there, or its catalog cannot be read): it stays here,
 * where the alias resolves as it always did, instead of a card the node parks.
 */
async function modelForNode(input: RemoteChildSpawnInput, machineId: string): Promise<string | null | undefined> {
  if (!input.model || !MODEL_ALIAS.test(input.model.trim())) return input.model;
  const baseUrl = input.baseUrlOf(machineId);
  const token = input.tokenOf(machineId);
  if (!baseUrl || !token || !input.nodeModels) return undefined;
  const listed = await input.nodeModels({ baseUrl, token }).catch(() => null);
  return listed ? nodeModelOf(input.model, listed) : undefined;
}

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
  const model = await modelForNode(input, node.machineId);
  if (model === undefined) return null;
  const bytes = await snapshotParentAsBundle({ repoPath: input.cwd, snapshotBranch: branch, marginCommits: CHILD_BUNDLE_MARGIN_COMMITS });
  if (!bytes) return null;
  // The bundle rides base64 inside one JSON body: an unignored build artefact would make a
  // gigabyte request. Over the cap the child stays here, where it needs no copy at all.
  if (bytes.byteLength > (input.maxBundleBytes ?? MAX_CHILD_BUNDLE_BYTES)) return null;
  const body: CreateRunBody = {
    originTaskId: input.id,
    originUrl: input.originUrl,
    text: input.prompt,
    description: input.name,
    model,
    effort: input.effort,
    baseBranch: branch,
    branchBundle: Buffer.from(bytes).toString("base64"),
  };
  let started: Awaited<ReturnType<typeof startRemoteChildRun>>;
  try {
    started = await startRemoteChildRun({ node, body, baseUrlOf: input.baseUrlOf, tokenOf: input.tokenOf, createRun: input.createRun });
  } catch (err) {
    // The node said no to this run (it has no checkout of this origin, `no_such_repo`, or it is
    // down): the child stays here, the same "no" as every step above. Throwing made the route
    // answer 500 and the parent's spawn failed outright on the first unknown repo (16/11).
    console.warn(`[spawn] remote child ${input.id}: ${node.name} refused the run, staying local: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!started.ok) return { ok: false, reason: started.reason };
  return { ok: true, machineId: node.machineId, runId: started.runId, branch };
}
