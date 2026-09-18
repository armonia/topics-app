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
const PROFILE = "/tmp/topics-sidecar-profile";

describe("the cleanup of a failed launch", () => {
  test("takes the top process AND the helpers, which killing the child misses", () => {
    const killed: number[] = [];
    const n = killByUserDataDir(PROFILE, {
      ps: () =>
        [
          row(100, 1, `${CHROME} --user-data-dir=${PROFILE} --remote-debugging-port=41000`),
          // The helpers: ppid 100 while the parent lives, ppid 1 after. Neither
          // carries the mark, both carry the profile.
          row(101, 100, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
          row(102, 1, `${CHROME} --type=gpu-process --user-data-dir=${PROFILE}`),
        ].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed.sort()).toEqual([100, 101, 102]);
    expect(n).toBe(3);
  });

  test("leaves a browser on ANOTHER profile alone", () => {
    // The guarantee that matters: the panes' Chromium (`browser-service.ts`)
    // and the person's own Chrome have profiles of their own, and a failed
    // sidecar launch must not close anybody's window.
    const killed: number[] = [];
    killByUserDataDir(PROFILE, {
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
    killByUserDataDir("/tmp/p", {
      ps: () => [row(300, 1, `${CHROME} --user-data-dir=/tmp/p-2`), row(301, 1, `${CHROME} --user-data-dir=/tmp/p`)].join("\n"),
      kill: (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([301]);
  });

  test("with no `ps` it shoots nobody instead of guessing", () => {
    const killed: number[] = [];
    const n = killByUserDataDir(PROFILE, { ps: () => null, kill: (pid) => { killed.push(pid); } });
    expect(killed).toEqual([]);
    expect(n).toBe(0);
  });

  test("one failing kill does not stop the others", () => {
    // A pid already dead between the snapshot and the signal is the norm, not
    // the exception: if it broke the loop, the helpers after it would stay
    // alive in exactly the case this function exists to close.
    const killed: number[] = [];
    killByUserDataDir(PROFILE, {
      ps: () =>
        [
          row(400, 1, `${CHROME} --user-data-dir=${PROFILE}`),
          row(401, 1, `${CHROME} --type=renderer --user-data-dir=${PROFILE}`),
        ].join("\n"),
      kill: (pid) => {
        if (pid === 400) throw new Error("ESRCH");
        killed.push(pid);
      },
    });
    expect(killed).toEqual([401]);
  });
});
