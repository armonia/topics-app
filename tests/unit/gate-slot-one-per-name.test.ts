/**
 * ONE RUN PER CHECK NAME, ACROSS WORKTREES.
 *
 * The count of slots was never the whole answer. It bounds how many expensive
 * commands run together and says nothing about WHICH: with three slots free,
 * three agents delivering at the same time from three worktrees each start
 * their own `lint`, because from inside a worktree it looks like the machine is
 * empty. Measured on 2026-09-07 while this card was written: two concurrent
 * lints held 1.3 GB, and the pair of `tsc` next to them 550 MB each.
 *
 * Serialising two runs of the SAME gate costs nothing in total work: they do
 * identical work on different trees, so one after the other each takes its
 * normal time instead of both taking twice as long.
 *
 * Driven through `acquireSlot` directly, with its own lock directory, because
 * the point is the protocol and not the wrapper: the same function is what the
 * script and the in-process preload both call.
 *
 * @covers SLOT-02
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot } from "../../scripts/gate-slot.ts";

let dir = "";
const fresh = (): string => {
  dir = mkdtempSync(join(tmpdir(), "topics-slot-name-"));
  process.env.TOPICS_GATE_SLOT_DIR = dir;
  return dir;
};

afterEach(() => {
  delete process.env.TOPICS_GATE_SLOT_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/**
 * IT IS A SERIALISER WITH A DEADLINE, not a lock, and the tests say so.
 *
 * Everything in `gate-slot.ts` fails open on purpose: past the wait the command
 * runs anyway, because a throttle that can block a gate forever is worse than
 * no throttle. So "one lint at a time" is proved by the WAIT, not by a refusal,
 * and the wait here is a quarter of a second instead of the ten real minutes.
 */
const WAIT_MS = 250;
const opts = (heard: string[] = []) => ({ maxWaitMs: WAIT_MS, onWait: (m: string) => heard.push(m) });

describe("the gate slot, per name", () => {
  it("a second run of the SAME gate waits for the first, with four slots free", () => {
    fresh();
    const first = acquireSlot(4, "lint", opts());
    expect(first).not.toBeNull();

    const heard: string[] = [];
    const started = Date.now();
    const second = acquireSlot(4, "lint", opts(heard));
    const waited = Date.now() - started;

    // Four slots are free, so the count is not what held it: the name is.
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS);
    expect(heard.some((m) => m.includes("already running on this machine"))).toBe(true);
    // And it ran anyway rather than failing: that is the contract of this file.
    expect(second).not.toBeNull();
    second!();
    first!();

    // Released: the next lint walks straight in, no wait at all.
    const third = acquireSlot(4, "lint", opts());
    expect(Date.now() - started).toBeLessThan(WAIT_MS * 4);
    expect(third).not.toBeNull();
    third!();
  });

  it("a gate waits for ANOTHER RUN OF ITSELF past the count deadline, when told to", () => {
    // 14/09 01:08: two full unit suites alive together, 11 GB each, because
    // the second had waited the count deadline and then run alongside. The
    // wrappers now give the name lock its own, longer wait: here the count
    // wait is 100 ms and the name wait 2 s, and the second run is held for the
    // name one. (2 s and not less: the lock is polled every 700 ms, so a wait
    // shorter than two polls cannot tell the two deadlines apart.)
    fresh();
    const first = acquireSlot(4, "test:unit", opts());
    const started = Date.now();
    const second = acquireSlot(4, "test:unit", { maxWaitMs: 100, nameMaxWaitMs: 2000, onWait: () => {} });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    // Still a limit, never forever (SLOT-02): past it the command runs.
    expect(second).not.toBeNull();
    second!();
    first!();
  });

  it("without a name wait of its own, name and count share ONE deadline, as before", () => {
    // The bun-test preload and the e2e shards do not pass `nameMaxWaitMs`.
    // With the name busy AND the only slot busy, their whole wait must stay one
    // deadline: a second deadline restarted after the name would double it.
    fresh();
    const holder = acquireSlot(1, "lint", opts());
    const started = Date.now();
    const second = acquireSlot(1, "lint", { maxWaitMs: 1500, onWait: () => {} });
    const waited = Date.now() - started;
    expect(second).toBeNull(); // gave up on the count, ran unthrottled
    // One deadline plus at most one poll (700 ms), never two deadlines.
    expect(waited).toBeLessThan(1500 + 1000);
    holder!();
  });

  it("a DIFFERENT gate is not held back by it", () => {
    fresh();
    const heard: string[] = [];
    const lint = acquireSlot(4, "lint", opts());
    const started = Date.now();
    const types = acquireSlot(4, "typecheck", opts(heard));
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
    expect(heard).toEqual([]);
    expect(lint).not.toBeNull();
    expect(types).not.toBeNull();
    lint!();
    types!();
  });

  it("the name is trimmed and lowercased: ` Lint` and `lint` are one gate", () => {
    fresh();
    const first = acquireSlot(4, "lint", opts());
    const heard: string[] = [];
    const second = acquireSlot(4, " Lint", opts(heard));
    expect(heard.some((m) => m.includes("already running on this machine"))).toBe(true);
    second!();
    first!();
  });

  it("giving up on the count gives the name back: a leaked name file would stop the next run for good", () => {
    fresh();
    // One numbered slot, and somebody else is holding it: this caller waits for
    // the count and then runs unthrottled (`null`). What must NOT survive it is
    // its name lock.
    const holder = acquireSlot(1, "typecheck", opts());
    expect(holder).not.toBeNull();
    expect(acquireSlot(1, "lint", opts())).toBeNull(); // no numbered slot left
    holder!();

    const heard: string[] = [];
    const after = acquireSlot(1, "lint", opts(heard));
    expect(heard.some((m) => m.includes("already running on this machine"))).toBe(false);
    expect(after).not.toBeNull();
    after!();
  });
});
