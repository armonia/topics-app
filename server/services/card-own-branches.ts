/**
 * Every branch that belongs to a card, by registration and never by ancestry.
 *
 * The land guard counts a commit reachable from a branch that is not the card's as
 * "another session's work". A branch that is the card's but is not named here makes the
 * guard refuse a green card (20/11: three cards bounced for a branch of their own).
 * Ancestry is deliberately not a rule: a branch of another session the card started
 * from is an ancestor too, and the guard has to stop exactly that.
 */

export interface CardOwnBranchSources {
  /** Branches of the card's recorded attempts. */
  attemptBranches: Array<string | null | undefined>;
  /** Delivery pointers the card carries: current, previous, past. */
  deliveryBranches: Array<string | null | undefined>;
  /** Session keys the card's agent ran under (its assigned chat, the chat it last had). */
  agentSessionKeys: Array<string | null | undefined>;
  /** Branches of the sub-agents spawned by a session key (`topics-child-<id>`, worktree branches). */
  childBranchesOf: (sessionKey: string) => Array<string | null | undefined>;
}

export function collectCardOwnBranches(src: CardOwnBranchSources): string[] {
  const keys = [...new Set(src.agentSessionKeys.filter((k): k is string => typeof k === "string" && k.length > 0))];
  const children = keys.flatMap((k) => src.childBranchesOf(k));
  const named = [...src.attemptBranches, ...src.deliveryBranches, ...children];
  return [...new Set(named.filter((b): b is string => typeof b === "string" && b.length > 0))];
}
