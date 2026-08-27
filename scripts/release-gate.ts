#!/usr/bin/env bun
/**
 * scripts/release-gate.ts - decide whether the tip of main may be released.
 *
 * WHAT IT ANSWERS, in one line: is the current tip of `main` a commit the CI
 * has already judged GREEN? If yes, the auto-bump job may write the version
 * commit on top of it and push. If no, it stops, and stopping is not a failure.
 *
 * WHY THE TIP AND NOT "the SHA the CI just approved". Measured on 27/08/2026 at
 * 08:30: 18 commits landed on origin/main in one hour while a CI run took ~13
 * minutes to judge one of them. The old job bumped the approved SHA and then
 * pushed - by then main had moved, the push was not fast-forward, and it gave
 * up. Correctly: forcing would erase somebody else's commit, and re-doing the
 * bump on the new tip would publish code the CI never saw. But it also meant
 * the chain only ever converged when a run happened to finish while its SHA was
 * still the tip, which is a coincidence, not a mechanism: no release at all
 * between 04:37 and 09:32 that day, then twelve once the rate dropped.
 *
 * Asking the question the other way round removes the race instead of losing
 * it. The candidate is the TIP, and the condition is a green verdict on THAT
 * exact SHA. Then:
 *   - the SHA that gets shipped is the SHA the CI measured, by construction;
 *   - the push is fast-forward, by construction (nothing to force, ever);
 *   - a tick that finds no verdict yet changes nothing and costs nothing, so
 *     the job can be re-run on a schedule until the answer becomes yes.
 * Releases come out in batches, one per quiet window rather than one per merge.
 * That is the trade this file makes, and it is deliberate.
 *
 * WHY A SCRIPT AND NOT AN `if:` IN THE YAML. A malformed expression in a
 * workflow condition has no way of being red: GitHub evaluates it as false and
 * skips the job in silence, so the broken shape of this gate is not "publishes
 * too much", it is "never publishes again and nobody notices for three weeks".
 * Here the decision is a pure function with a test per branch.
 */
import { appendFileSync } from "node:fs";

/** The subset of a GitHub Actions run this gate reads. */
export type CiRun = {
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
};

export type GateInput = {
  /** The tip of the release branch, right now. */
  tipSha: string;
  /** Subject line of the tip commit, for the anti-loop net. */
  tipMessage: string;
  /** The branch being released. Anything but `main` is refused. */
  branch: string;
  /** The most recent CI run for `tipSha`, or null when there is none yet. */
  run: CiRun | null;
};

type GateDecision =
  | { publish: true; sha: string }
  | { publish: false; reason: string };

/** The release branch. Nothing else ever reaches the auto-updater. */
const RELEASE_BRANCH = "main";

/** Prefix of the version commit this very job writes. */
const BUMP_PREFIX = "chore(release):";

/**
 * The whole gate. Pure on purpose: the workflow gathers the facts, this decides.
 */
export function decide(input: GateInput): GateDecision {
  if (input.branch !== RELEASE_BRANCH) {
    return { publish: false, reason: `branch ${input.branch} is not ${RELEASE_BRANCH}` };
  }

  // Anti-loop, second net. The first one is that the bump is pushed with the
  // default GITHUB_TOKEN, which by design triggers no workflow, so the tip
  // commit of a bump has no CI run at all and would be refused below anyway.
  // One net on a cycle that publishes to every user is not enough.
  if (input.tipMessage.startsWith(BUMP_PREFIX)) {
    return { publish: false, reason: "the tip is already a version commit" };
  }

  const run = input.run;
  if (!run) {
    return { publish: false, reason: `no CI run for ${short(input.tipSha)} yet` };
  }

  // A run on another SHA says nothing about this one. This is the check the
  // whole redesign exists for, so it is explicit rather than implied by the
  // query that fetched the run.
  if (run.head_sha !== input.tipSha) {
    return {
      publish: false,
      reason: `the run measured ${short(run.head_sha)}, the tip is ${short(input.tipSha)}`,
    };
  }

  if (run.head_branch !== RELEASE_BRANCH) {
    return { publish: false, reason: `the run measured branch ${run.head_branch}` };
  }

  // `queued` and `in_progress` are "not yet", not "no": the next tick asks
  // again. Only a completed run has a verdict to read.
  if (run.status !== "completed") {
    return { publish: false, reason: `CI is ${run.status} on ${short(input.tipSha)}` };
  }

  // `cancelled`, `failure`, `timed_out`, `skipped`, `action_required` are all
  // "we do not know, or we know it is no", and none of the five deserves being
  // pushed to everybody's auto-updater.
  if (run.conclusion !== "success") {
    return { publish: false, reason: `CI concluded ${run.conclusion} on ${short(input.tipSha)}` };
  }

  return { publish: true, sha: input.tipSha };
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * CLI shape: the facts arrive as one JSON object on stdin, the decision goes to
 * `$GITHUB_OUTPUT` (`publish`, `sha`, `reason`) and, readable, to stderr.
 *
 * The exit code is ZERO whatever the answer. Giving up is the RIGHT move here,
 * and a red run that is not a fault teaches people to stop looking at red runs.
 * The brake is the `publish` output, which the push step is guarded on.
 */
async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const decision = decide(JSON.parse(raw) as GateInput);

  const lines = decision.publish
    ? [`publish=true`, `sha=${decision.sha}`, `reason=`]
    : [`publish=false`, `sha=`, `reason=${decision.reason}`];

  // Appended, never rewritten: `$GITHUB_OUTPUT` is a file the step accumulates
  // into, and truncating it is how a step silently loses the value before it.
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${lines.join("\n")}\n`);

  console.error(
    decision.publish
      ? `[release-gate] release ${short(decision.sha)}: the tip of main is green.`
      : `[release-gate] no release: ${decision.reason}.`,
  );
}

// Runs only when this file IS the process, so the test can import `decide`.
if (import.meta.main) await main();
