/**
 * The node half of the cross-machine worktree wiring, as the server builds it:
 * the policy a primary sends is checked by THIS machine's root rules (the
 * same `validateSettingsPatch` as `PUT /api/app-settings`), and a cleanup asked
 * from the primary is this machine's own pass, called with nothing from the caller.
 *
 * @covers WORKTREE-STD-16
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { AppContext } from "../types";
import { createWorktreeReportDeps } from "./worktree-node-wiring";

function build() {
  const calls: unknown[][] = [];
  const ctx = {
    projectStore: { list: () => [{ id: "p1", path: "/repos/app" }], get: () => null },
    worktreeManager: { worktreesDir: () => "/srv/wt" },
    machineStore: { list: () => [], getByHostname: () => null, worktreeReport: () => null },
    STATE_DIR: "/nowhere",
  } as unknown as AppContext;
  const deps = createWorktreeReportDeps(ctx, {
    worktreeGc: {
      planWorktreeGc: async () => null,
      runWorktreeGc: async (...args: unknown[]) => { calls.push(args); return null; },
    },
    nodeClient: { putWorktreePolicy: async () => { throw new Error("not on the node"); }, worktreeGc: async () => { throw new Error("not on the node"); } },
  });
  return { node: deps.node(), calls };
}

describe("the node's worktree wiring", () => {
  test("a policy root is refused by this machine's own rules: its home, inside one of its projects", () => {
    const { node } = build();
    const home = node.validate({ worktreeRoot: homedir() });
    expect(home.errors).toEqual([expect.objectContaining({ field: "worktreeRoot", code: "home" })]);
    const inProject = node.validate({ worktreeRoot: "/repos/app/wt" });
    expect(inProject.errors).toEqual([expect.objectContaining({ field: "worktreeRoot", code: "inside-project" })]);
  });

  test("the cleanup the primary asks for is this machine's own pass, given nothing", async () => {
    const { node, calls } = build();
    await node.runGc();
    expect(calls).toEqual([[]]);
  });
});
