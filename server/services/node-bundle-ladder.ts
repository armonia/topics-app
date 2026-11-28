/**
 * The bundle a node without origin receives, widened step by step. Such a node never fetches, so
 * its main stays where it was cloned and the thin bundle (cut at the sender's origin/HEAD) lacks
 * prerequisites it does not hold (27/11: 16 refusals on 14 cards, card 923a20b2). The whole
 * history is the last step: 148 MB against 4.8 MB for the 200-commit margin.
 */
import { CHILD_BUNDLE_MARGIN_COMMITS } from "../lib/subagent-remote-spawn";
import { isNodeError } from "./node-client";
import type { BundleReach } from "./branch-on-origin";

export const CARD_BUNDLE_LADDER: readonly BundleReach[] = [0, CHILD_BUNDLE_MARGIN_COMMITS, "whole"];

/**
 * The node could not verify the bundle. "invalid bundle" counts too: the node keeps only the last
 * 120 characters of git's stderr (`plantCarriedBranch`), so with two or more missing commits the
 * word "prerequisite" is cut away and only the hashes remain.
 */
export function isPrerequisiteRefusal(err: unknown): boolean {
  return isNodeError(err) && err.status === 400 && /prerequisite|invalid bundle/i.test(err.message);
}

/** A node without origin can have stale main, so retry broader bundles only on a prerequisite refusal. */
export async function createRunWithBundle<T>(
  make: (reach: BundleReach) => Promise<Uint8Array | null>,
  create: (bundleBase64: string) => Promise<T>,
  ladder: readonly BundleReach[] = CARD_BUNDLE_LADDER,
): Promise<T | null> {
  let previous: Uint8Array | null = null;
  let lastRefusal: unknown;
  for (let i = 0; i < ladder.length; i++) {
    const bytes = await make(ladder[i]!);
    if (!bytes) {
      if (i === 0) return null;
      throw lastRefusal;
    }
    if (previous && Buffer.compare(bytes, previous) === 0) continue;
    previous = bytes;
    try {
      return await create(Buffer.from(bytes).toString("base64"));
    } catch (err) {
      if (!isPrerequisiteRefusal(err) || i === ladder.length - 1) throw err;
      lastRefusal = err;
    }
  }
  if (lastRefusal) throw lastRefusal;
  return null;
}
