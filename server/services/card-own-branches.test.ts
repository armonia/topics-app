/**
 * Registration, not ancestry: a card's own branches are the ones it names, and a branch of
 * another card it started from stays foreign (the 17/11 half land).
 *
 * @covers LAND-04
 */
import { describe, test, expect } from "bun:test";
import { collectCardOwnBranches } from "./card-own-branches";

const base = { attemptBranches: [], deliveryBranches: [], agentSessionKeys: [], childBranchesOf: () => [] as string[] };

describe("collectCardOwnBranches", () => {
  test("a spawned child's branch is the card's own", () => {
    const own = collectCardOwnBranches({
      ...base,
      deliveryBranches: ["topics/card"],
      agentSessionKeys: ["topic:abc12345", "topic:abc12345", null],
      childBranchesOf: (k) => (k === "topic:abc12345" ? ["topics-child-1", null] : []),
    });
    expect(own).toEqual(["topics/card", "topics-child-1"]);
  });

  test("an old attempt branch and a worktree branch are the card's own, deduplicated", () => {
    const own = collectCardOwnBranches({ ...base, attemptBranches: ["topics/old", "topics/new"], deliveryBranches: ["topics/new", undefined] });
    expect(own).toEqual(["topics/old", "topics/new"]);
  });

  test("a branch the card merely descends from is not named", () => {
    const own = collectCardOwnBranches({ ...base, deliveryBranches: ["topics/card"], agentSessionKeys: ["topic:abc12345"] });
    expect(own).not.toContain("topics/other-card");
  });
});
