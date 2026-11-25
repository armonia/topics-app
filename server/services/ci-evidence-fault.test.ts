/**
 * Which failed steps of the CI measure are the board's own fault, and what the first push and the lease push
 * do with them: a cut or unreachable push is measured again in the same round, a hook that declines the
 * content is the card's.
 *
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { E2E_CI_CHECK, UNIT_CI_CHECK } from "../../shared/board";
import { awaitCiEvidence, type GithubPort } from "./ci-evidence";
import { isBoardFault, pushRejectedAsNonFastForward } from "./ci-evidence-fault";

const SHA = "a".repeat(40);
const both = { cwd: "/tmp/wt", sha: SHA, taskId: "12345678-card", checks: [E2E_CI_CHECK, UNIT_CI_CHECK] };

/** Only what a measure that stops at the push needs. */
function portWithPush(push: GithubPort["push"], over: Partial<GithubPort> = {}): GithubPort {
  return {
    ownCommits: async () => ({ ok: true, value: 2 }),
    branch: async () => ({ ok: true, value: "topics/card" }),
    repo: async () => ({ ok: true, value: "o/r" }),
    push,
    remoteHead: async () => ({ ok: true, value: "c".repeat(40) }),
    inReflog: async () => ({ ok: true, value: true }),
    contains: async () => ({ ok: true, value: false }),
    openPullRequest: async () => ({ ok: true, value: null }),
    ...over,
  } as unknown as GithubPort;
}

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, stopping: () => false };
};

describe("push classification", () => {
  test("remote and porcelain parsing", () => {
    expect(pushRejectedAsNonFastForward("!\trefs/x:refs/heads/b\t[rejected] (non-fast-forward)")).toBe(true);
    expect(pushRejectedAsNonFastForward("=\trefs/x:refs/heads/b\t[up to date]")).toBe(false);
  });

  test("timeouts, transport and auth are the board's; a hook refusal is not", () => {
    expect(isBoardFault("exited 137: killed after 300 s")).toBe(true);
    expect(isBoardFault("fatal: unable to access 'https://github.com/o/r/': Failed to connect")).toBe(true);
    expect(isBoardFault("remote: Invalid username or password.\nfatal: Authentication failed")).toBe(true);
    expect(isBoardFault("gh exited 1: HTTP 502: Bad Gateway")).toBe(true);
    expect(isBoardFault("exited 1: pre-push hook declined\nerror: failed to push some refs")).toBe(false);
  });
});

describe("a failed push in awaitCiEvidence", () => {
  test("a first push that fails is TRANSIENT: the round measures it again instead of giving up on the delivery", async () => {
    const port = portWithPush(async () => ({ ok: false, error: "git push --porcelain exited 128: Could not resolve host: github.com" }));
    const rows = await awaitCiEvidence(both, { port, ...clock() });
    expect(rows.map((r) => r.transient)).toEqual([true, true]);
  });

  test("a push with lease that fails is not transient, as before", async () => {
    const port = portWithPush(async (_c, _s, _b, lease) => (lease ? { ok: false, error: "stale info" } : { ok: true, value: "non-fast-forward" }));
    const rows = await awaitCiEvidence(both, { port, ...clock() });
    expect(rows.map((r) => r.transient)).toEqual([undefined, undefined]);
  });

  test("a push cut by its cap is a board fault; a pre-push hook that declines the content is not", async () => {
    const faults: string[] = [];
    const onFault = (step: string, error: string) => { faults.push(`${step}: ${error}`); };
    const killed = portWithPush(async () => ({ ok: false, error: "git push --porcelain exited 137: killed after 300 s" }));
    await awaitCiEvidence({ ...both, onFault }, { port: killed, ...clock() });
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("push: push failed");
    const declined = portWithPush(async () => ({ ok: false, error: "git push --porcelain exited 1: pre-push: check-push-clean found a forbidden file\nerror: failed to push some refs" }));
    const rows = await awaitCiEvidence({ ...both, onFault }, { port: declined, ...clock() });
    expect(faults).toHaveLength(1);
    expect(rows.map((r) => r.notMeasured)).toEqual([true, true]);
  });
});
