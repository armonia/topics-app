/**
 * THE RITORNO LEG of SUBAGENT-26, wired (SUBAGENT-28): once a remote child's
 * run reaches `review` on the node, its branch bundle is fetched and landed
 * in the parent as an ordinary branch — `plantCarriedBranch` (reused as is
 * from the card lane, `branch-on-origin.ts`) then `adoptCarriedBranch`
 * (`subagent-bundle.ts`, SUBAGENT-26). Both already exist; this only
 * sequences them and turns a failed step into a reason, never a throw.
 */
import type { BundleResult } from "../services/node-client";
import { plantCarriedBranch } from "../services/branch-on-origin";
import { adoptCarriedBranch } from "./subagent-bundle";
import type { GitRunner } from "../services/own-commits";

export interface SettleRemoteChildInput {
  /** The parent's own checkout, where the branch is adopted. */
  repoPath: string;
  branch: string;
  /** The branch the node delivered under (`report.deliveryBranch`): the head its bundle holds. */
  deliveredBranch?: string | null;
  fetchBundle: () => Promise<BundleResult>;
  run?: GitRunner;
}

export type SettleRemoteChildResult = { ok: true } | { ok: false; reason: string };

export async function settleRemoteChildBranch(input: SettleRemoteChildInput): Promise<SettleRemoteChildResult> {
  const { repoPath, branch } = input;
  let bundle: BundleResult;
  try {
    bundle = await input.fetchBundle();
  } catch (err) {
    return { ok: false, reason: `the bundle did not arrive from the node: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (bundle.empty) return { ok: false, reason: "the node answered with no branch bundle" };
  const planted = await plantCarriedBranch(repoPath, branch, bundle.bytes, input.run, input.deliveredBranch || branch);
  if (!planted.ok) return { ok: false, reason: `branchBundle: ${planted.reason}` };
  return adoptCarriedBranch({ repoPath, branch, run: input.run });
}
