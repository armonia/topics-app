/**
 * THE GATE BETWEEN THE CI AND WHAT REACHES THE AUTO-UPDATER.
 *
 * `auto-bump.yml` does not only build: it PUBLISHES, and what it publishes
 * lands on the auto-updater of anybody with Topics open. Until 2026-08-16 it
 * fired on `push: branches: [main]` and the only gate was the installers
 * compiling: measured over 60 runs, 37 successful releases, 28 of them on a SHA
 * whose CI was red or cancelled.
 *
 * WHY A TEST AND NOT "you can see it in the file". The cost of being wrong here
 * is not symmetric. A badly written `if` in a workflow has no way of being red:
 * GitHub evaluates an invalid expression as FALSE and skips the job in silence,
 * so the broken shape of this gate is not "publishes too much", it is "never
 * publishes again and nobody notices until a user asks why they are three weeks
 * behind". That is why, since 2026-08-27, the decision is not an `if:` at all
 * but a pure function, `decide()` in `scripts/release-gate.ts`, and this file
 * calls THAT function instead of replaying a copy of it.
 *
 * WHAT CHANGED THAT DAY. The job used to bump the SHA the CI had approved and
 * then push. At 18 commits an hour against a 13-minute CI, main had always
 * moved by then, the push was not fast-forward, and it gave up - correctly, and
 * forever: no release between 04:37 and 09:32. The candidate is now THE TIP of
 * main and the condition is a green verdict on that exact SHA, so the shipped
 * SHA is the measured SHA by construction and the push is fast-forward by
 * construction. The tests below are the branches of that decision.
 *
 * @covers RELEASE-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decide, type CiRun, type GateInput } from "../../scripts/release-gate";

const ROOT = resolve(import.meta.dir, "../..");
const WF = readFileSync(resolve(ROOT, ".github/workflows/auto-bump.yml"), "utf8");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

const TIP = "1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff";

const run = (over: Partial<CiRun> = {}): CiRun => ({
  status: "completed",
  conclusion: "success",
  head_sha: TIP,
  head_branch: "main",
  ...over,
});

const input = (over: Partial<GateInput> = {}): GateInput => ({
  tipSha: TIP,
  tipMessage: "Any commit at all",
  branch: "main",
  run: run(),
  ...over,
});

describe("release-gate: only a green tip of main gets published", () => {
  it("a green CI on the tip of main publishes THAT sha", () => {
    expect(decide(input())).toEqual({ publish: true, sha: TIP });
  });

  it("a RED CI does not publish", () => {
    expect(decide(input({ run: run({ conclusion: "failure" }) })).publish).toBe(false);
  });

  it("a CANCELLED CI does not publish: «we do not know» is not «fine»", () => {
    // 37 of the last 100 runs on main were cancelled, all of them inside a
    // high-rate window: the pending run evicted by the next push. Treating them
    // as green would put back a third of the cases this gate exists to stop.
    for (const conclusion of ["cancelled", "timed_out", "skipped", "action_required", null]) {
      expect(decide(input({ run: run({ conclusion }) })).publish).toBe(false);
    }
  });

  it("a CI still running is «not yet», and the next tick asks again", () => {
    for (const status of ["queued", "in_progress", "waiting"]) {
      const d = decide(input({ run: run({ status, conclusion: null }) }));
      expect(d.publish).toBe(false);
      expect(d).toHaveProperty("reason");
    }
  });

  it("NO run on the tip does not publish", () => {
    // The hole that used to park the chain: a run evicted from the queue never
    // completes, so this sha has no verdict and never will. Skipping is right;
    // what changed is that the next merge is no longer the only way out.
    expect(decide(input({ run: null })).publish).toBe(false);
  });

  it("THE HEART OF IT: a green run on ANOTHER sha does not publish this tip", () => {
    // The old shape shipped the approved SHA and let the push arbitrate. This
    // one refuses before building anything, which is the same refusal moved to
    // where it can be tested.
    const other = "0badc0de0badc0de0badc0de0badc0de0badc0de";
    expect(decide(input({ run: run({ head_sha: other }) })).publish).toBe(false);
  });

  it("a run measured on another branch does not publish", () => {
    expect(decide(input({ run: run({ head_branch: "feature/whatever" }) })).publish).toBe(false);
  });

  it("the bump commit does not bump itself: no loop", () => {
    // Second net. The first is that the default GITHUB_TOKEN triggers no
    // workflow, so the CI never runs on a bump commit and it would be refused
    // above for having no run. One net on a cycle that publishes to users is
    // not enough.
    expect(decide(input({ tipMessage: "chore(release): bump v2.2.191" })).publish).toBe(false);
  });

  it("a branch that is not main does not publish", () => {
    expect(decide(input({ branch: "release/2.3" })).publish).toBe(false);
  });

  it("every refusal says why: the reason is what the run prints", () => {
    // A gate that stops without a reason is indistinguishable from a gate that
    // is broken, and this one is allowed to stop often.
    const d = decide(input({ run: run({ conclusion: "failure" }) }));
    expect(d.publish).toBe(false);
    if (!d.publish) expect(d.reason.length).toBeGreaterThan(10);
  });
});

describe("auto-bump.yml: the workflow asks the script, and asks it again", () => {
  it("the gate step feeds the tip to release-gate.ts", () => {
    expect(WF).toContain("bun run scripts/release-gate.ts");
    expect(WF).toMatch(/id: gate/);
  });

  it("the bump, the changelog and the push are all guarded on its answer", () => {
    const guards = WF.match(/if: \$\{\{ steps\.gate\.outputs\.publish == 'true' \}\}/g) ?? [];
    expect(guards.length).toBe(3);
  });

  it("no job-level `if` reads the workflow_run payload any more", () => {
    // It is empty on a scheduled tick, and a condition that quietly evaluates
    // to false is how this chain would stop publishing with no red run to show.
    expect(WF).not.toMatch(/if:[\s\S]{0,200}github\.event\.workflow_run\.conclusion/);
  });

  it("it checks out the TIP of main, not the sha of the event", () => {
    expect(WF).toMatch(/fetch-depth: 0\n(\s+#.*\n)*\s+ref: main/);
    expect(WF).not.toContain("ref: ${{ github.event.workflow_run.head_sha }}");
  });

  it("THE CONVERGENCE: a scheduled tick asks again without a new merge", () => {
    // Without this the only tick is `workflow_run`, and a release then depends
    // on a run finishing while its commit is still the tip - which is the
    // coincidence that left the chain still for five hours on 27/08/2026.
    expect(WF).toMatch(/schedule:\s*\n\s+- cron: "\*\/10 \* \* \* \*"/);
    expect(WF).toMatch(/workflow_run:/);
    expect(WF).toMatch(/workflows:\s*\[CI\]/);
  });

  it("nothing is ever force-pushed", () => {
    expect(WF).not.toMatch(/push[^\n]*(--force|-f\b)/);
  });

  it("giving up exits zero: a refusal is not a fault", () => {
    // An `exit 1` on the losing side of a race paints a run red on a day when
    // nothing broke, and a red that is not a fault teaches people to ignore
    // reds. The brake is the missing `sha` output, not the colour.
    expect(WF).toMatch(/if ! git push origin "HEAD:main"; then[\s\S]*?exit 0\n\s+fi/);
  });

  it("the release job stays hung on bump, so the gate covers it too", () => {
    expect(WF).toMatch(/release:\s*\n\s+needs:\s*bump/);
    expect(WF).toContain("if: ${{ needs.bump.outputs.sha != '' }}");
  });
});

describe("ci.yml: on main no run waits behind another, so none is evicted", () => {
  it("the concurrency group on main is per-SHA", () => {
    // GitHub keeps ONE pending run per group: with a single group for main, the
    // third push evicts the second and that commit is measured by nobody. 37 of
    // the last 100 runs on main died that way. One group per sha, no queue, no
    // eviction - and the gate above always has a verdict to read.
    expect(CI).toContain(
      "group: ci-${{ github.ref }}-${{ github.ref == 'refs/heads/main' && github.sha || 'tip' }}",
    );
  });

  it("cancelling in progress stays off on main, on everywhere else", () => {
    expect(CI).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
  });
});
