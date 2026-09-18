/**
 * @covers RUNTIME-06
 *
 * THE BROWSER ON OUR PORT MUST BE THE ONE WE SPAWNED.
 *
 * The sidecar's debugging port is FIXED at 19333, and `waitForCdpEndpoint` used
 * to accept whatever answered there. Measured on 2026-09-18 on this machine:
 * `acquire()` returned in 0,3 s with a valid endpoint that belonged to **Dia**,
 * the user's own browser, which listens on 19333 with remote debugging on. The
 * sidecar reported `engine: Dia` and would have driven a real browsing session:
 * that person's tabs, cookies and logged-in accounts.
 *
 * `/json/version` cannot tell them apart. It answers `Chrome/153.0.8010.53` for
 * Dia too, because Dia IS a Chromium. The only question that separates the two
 * cases is "is what answers MINE", and this module can ask it in the strongest
 * form: it just spawned the process, so it knows the pid.
 *
 * `server/lib/port-squatter.ts` already carries this doctrine for the HTTP
 * port, written after nine hours of a foreign server answering on 3333. The
 * sidecar was the one door still unguarded.
 */
import { describe, expect, test } from "bun:test";
import { portOwnedBy } from "./browser-chromium-sidecar";

const row = (pid: number, ppid: number, command: string) => `${pid} ${ppid} ${command}`;

describe("who owns the debugging port", () => {
  test("the pid we spawned holds it: ours", () => {
    expect(portOwnedBy(19333, 5000, { lsof: () => "5000\n" })).toBe(true);
  });

  test("a CHILD of the pid we spawned holds it: still ours", () => {
    // Not an edge case: Chromium re-execs, and the process that ends up owning
    // the debugging socket is routinely a child of the one we spawned. Comparing
    // pids alone would reject our own browser and break every launch.
    const ps = () => [row(5000, 1, "chrome"), row(5001, 5000, "chrome --type=zygote"), row(5002, 5001, "chrome")].join("\n");
    expect(portOwnedBy(19333, 5000, { lsof: () => "5002\n", ps })).toBe(true);
  });

  test("somebody else's browser holds it: NOT ours", () => {
    // The measured case: Dia, pid 99673, on 19333. Nothing links it to us.
    const ps = () => [row(99673, 1, "/Applications/Dia.app/Contents/MacOS/Dia"), row(5000, 1, "chrome")].join("\n");
    expect(portOwnedBy(19333, 5000, { lsof: () => "99673\n", ps })).toBe(false);
  });

  test("TWO holders, one of them ours: still NOT ours", () => {
    // This is the case that broke the first version of the guard, found by
    // running it for real: with a foreign server already on the port, our
    // browser starts and binds TOO, so `lsof` lists both. Asking "is one of
    // them ours" answered yes and accepted the endpoint the FOREIGN one had
    // served. Two holders means we cannot know whose reply we got, and not
    // knowing is a refusal.
    // OUR pid comes FIRST in the list, and that ordering is the point: `lsof`
    // does not promise an order, so without the holder-count guard the code
    // reads `holders[0]`, finds itself, and answers `true` while the reply we
    // actually got came from the other one. Removing that guard turns this case
    // green, which is how it was caught.
    const ps = () => [row(5000, 1, "chrome"), row(6000, 1, "estraneo")].join("\n");
    expect(portOwnedBy(19333, 5000, { lsof: () => "5000\n6000\n", ps })).toBe(false);
  });

  test("no lsof: `null`, which the caller treats as accept", () => {
    // The check exists to remove a silent hijack, not to add a new way to be
    // down: on a machine without `lsof` the launch must still work.
    expect(portOwnedBy(19333, 5000, { lsof: () => null })).toBeNull();
  });

  test("nobody is listening: `null`, not a verdict", () => {
    // Called while the browser is still coming up. "Not yet" is not "foreign",
    // and answering `false` here would turn every slow boot into a hijack.
    expect(portOwnedBy(19333, 5000, { lsof: () => "\n" })).toBeNull();
  });

  test("a parent chain that loops does not hang the probe", () => {
    // A `ps` snapshot is not a tree under a guarantee: pids get recycled and two
    // rows can point at each other. The walk is bounded, so a cycle answers
    // instead of spinning.
    const ps = () => [row(10, 11, "a"), row(11, 10, "b")].join("\n");
    expect(portOwnedBy(19333, 5000, { lsof: () => "10\n", ps })).toBe(false);
  });
});
