/**
 * @covers RUNTIME-06
 *
 * A FAILED LAUNCH LEAVES NO TREE STANDING.
 *
 * `child.kill()` kills the process we spawned, not the helpers Chromium has
 * already forked (renderer, GPU, utility, zygote): those stay with ppid 1, and
 * the sidecar's profile is FIXED, so the leftover holding it open makes the
 * next launch fail too.
 *
 * MEASURED on 2026-09-18 while measuring the extension boot cost: ten orphaned
 * `Chrome for Testing` with ppid 1, two alive 18 minutes after a kill that
 * succeeded on the top process.
 *
 * And the error branch is not rare: `waitForCdpEndpoint` waits 10 s, but
 * booting with this machine's 42 extensions takes 288, and already 28,8 at
 * five. On the default configuration the sidecar launch always ends there.
 *
 * Helpers do not carry the `--topics-browser=` mark (Chromium does not forward
 * switches it does not know) but they do carry their browser's
 * `--user-data-dir`: that is the key that collects them, the same one
 * `planBootSweep` rests on.
 */
import { describe, expect, test } from "bun:test";
import { killByUserDataDir } from "./browser-chromium-sidecar";

/** One line of `ps -axo pid=,ppid=,command=`. */
const row = (pid: number, ppid: number, command: string) => `${pid} ${ppid} ${command}`;

const CHROME = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
// DATA, not a directory: it appears inside fake `ps` lines and is only compared
// with the one on other, equally fake lines. These tests create nothing on disk,
// so there is nothing to isolate between two parallel runs.
const PROFILE = "/tmp/topics-sidecar-profile"; // allow-shared-tmp: a string in fake ps lines, no directory is created

describe("the cleanup of a failed launch", () => {
  test("takes the top process AND the helpers that are still attached to it", () => {
    const killed: number[] = [];
    const n = killByUserDataDir(PROFILE, 100, {
      ps: () =>
        [
          row(100, 1, `${CHROME} --user-data-dir=${PROFILE} --remote-debugging-port=41000`),
          // Helpers keep ppid 100 while the parent lives, which is the case on
          // the error path: the parent has not been killed yet when the sweep
          // runs.
          row(101, 100, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
          row(102, 101, `${CHROME} --type=gpu-process --user-data-dir=${PROFILE}`),
        ].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed.sort()).toEqual([100, 101, 102]);
    expect(n).toBe(3);
  });

  test("a helper ALREADY reparented to init is left behind, and that is the trade", () => {
    // THE HONEST LIMIT of keying on ancestry. A helper whose parent already
    // died reads ppid 1, and from `ps` alone it is indistinguishable from
    // another instance's helper on the same shared profile. The old code took
    // it - and took the co-tenant's whole tree with it, which is the defect
    // this file now exists to prevent.
    //
    // Cost of this choice: one orphaned helper survives a failed launch, and
    // the boot sweep (`planBootSweep`) collects it later. Cost of the opposite
    // choice, measured with two real Chromiums: nine live processes of
    // somebody's browsing session, SIGKILLed.
    const killed: number[] = [];
    killByUserDataDir(PROFILE, 100, {
      ps: () =>
        [
          row(100, 1, `${CHROME} --user-data-dir=${PROFILE}`),
          row(103, 1, `${CHROME} --type=gpu-process --user-data-dir=${PROFILE}`),
        ].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([100]);
  });

  test("leaves a browser on ANOTHER profile alone", () => {
    // The guarantee that matters: the panes' Chromium (`browser-service.ts`)
    // and the person's own Chrome have profiles of their own, and a failed
    // sidecar launch must not close anybody's window.
    const killed: number[] = [];
    killByUserDataDir(PROFILE, 202, {
      ps: () =>
        [
          row(200, 1, `${CHROME} --user-data-dir=/tmp/altro-profilo`),
          row(201, 1, `${CHROME} --type=renderer --user-data-dir=/Users/me/Library/Application Support/Google/Chrome`),
          row(202, 1, `${CHROME} --user-data-dir=${PROFILE}`),
        ].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([202]);
  });

  test("a prefix is not the profile: `-2` is not the same as ``", () => {
    // `--user-data-dir=/tmp/p-2` does not belong to profile `/tmp/p`, and a
    // prefix comparison would kill it: those are two sidecars of two servers.
    const killed: number[] = [];
    killByUserDataDir("/tmp/p", 301, {
      ps: () => [row(300, 1, `${CHROME} --user-data-dir=/tmp/p-2`), row(301, 1, `${CHROME} --user-data-dir=/tmp/p`)].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([301]);
  });

  test("with no `ps` it shoots nobody instead of guessing", () => {
    const killed: number[] = [];
    const n = killByUserDataDir(PROFILE, 100, { ps: () => null, kill: (pid) => { killed.push(pid); } });
    expect(killed).toEqual([]);
    expect(n).toBe(0);
  });

  test("one failing kill does not stop the others", () => {
    // A pid already dead between the snapshot and the signal is the norm, not
    // the exception: if it broke the loop, the helpers after it would stay
    // alive in exactly the case this function exists to close.
    const killed: number[] = [];
    killByUserDataDir(PROFILE, 400, {
      ps: () =>
        [
          row(400, 1, `${CHROME} --user-data-dir=${PROFILE}`),
          row(401, 400, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
        ].join("\n"),
      kill: (pid) => {
        if (pid === 400) throw new Error("ESRCH");
        killed.push(pid);
      },
    });
    expect(killed).toEqual([401]);
  });
});

describe("a second server instance must not kill the first one's browser", () => {
  // THE DEFECT THIS FILE MISSED THE FIRST TIME, found by running two real
  // Chromiums instead of trusting fake `ps` lines.
  //
  // The sidecar profile is FIXED and so is port 19333, so two server instances
  // share both by construction. The second one fails to take the port (the
  // ownership guard added in PR #99 is what refuses it), enters the error path,
  // and the first version of `killByUserDataDir` SIGKILLed every process
  // carrying that profile - nine live processes belonging to the FIRST
  // instance's browser. Somebody's browsing, closed by a launch that failed.
  //
  // Same profile is not ownership. Only ancestry is.
  test("processes on the SAME profile but from another tree are left alone", () => {
    const killed: number[] = [];
    // 5000 is the browser THIS instance spawned; 6000 belongs to the other
    // server, with its own helpers, on the very same profile.
    const ps = () =>
      [
        row(5000, 1, `${CHROME} --user-data-dir=${PROFILE}`),
        row(5001, 5000, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
        row(6000, 1, `${CHROME} --user-data-dir=${PROFILE}`),
        row(6001, 6000, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
        row(6002, 6001, `${CHROME} --type=utility --user-data-dir=${PROFILE}`),
      ].join("\n");
    killByUserDataDir(PROFILE, 5000, { ps, kill: (pid) => { killed.push(pid); } });
    expect(killed.sort()).toEqual([5000, 5001]);
  });

  test("without a pid it sweeps NOTHING, instead of sweeping everything", () => {
    // The old signature had no pid at all, and `child.pid` is `number |
    // undefined` in Node's types: a spawn that failed leaves it undefined, and
    // that is a real path, not a hypothetical. The safe answer there is to do
    // nothing - a leftover tree costs memory, a wrong SIGKILL costs somebody's
    // session.
    //
    // NOTE ON WHAT THIS TEST PROVES. Removing the `ownPid === undefined` guard
    // does NOT turn it red, because with `ownPid` undefined the ancestry walk
    // refuses every row anyway: the guard is a second lock on a door that is
    // already shut, kept because it states the intent where a reader looks for
    // it. The row below is what actually holds: a process on our profile, and
    // nothing killed.
    const killed: number[] = [];
    const n = killByUserDataDir(PROFILE, undefined, {
      ps: () => [row(5000, 1, `${CHROME} --user-data-dir=${PROFILE}`)].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([]);
    expect(n).toBe(0);
  });

  test("a deep helper of our own tree is still collected", () => {
    // The ancestry walk must not be so strict that it misses our own grandchild:
    // Chromium nests zygote -> renderer, and a fix that leaks those would have
    // traded one leak for another.
    const killed: number[] = [];
    const ps = () =>
      [
        row(5000, 1, `${CHROME} --user-data-dir=${PROFILE}`),
        row(5001, 5000, `${CHROME} --type=zygote --user-data-dir=${PROFILE}`),
        row(5002, 5001, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
      ].join("\n");
    killByUserDataDir(PROFILE, 5000, { ps, kill: (pid) => { killed.push(pid); } });
    expect(killed.sort()).toEqual([5000, 5001, 5002]);
  });
});
