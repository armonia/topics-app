/**
 * THE JUNIT REPORT BELONGS TO ONE RUN, and two runs cannot meet on it.
 *
 * WHAT WAS MEASURED, 2026-08-27 at 02:40: two full `bun test` runs alive at
 * once from the same worktree, both carrying
 * `--reporter=junit --reporter-outfile=/tmp/unit.xml`. One fixed path under
 * /tmp, two writers: the second overwrites the first, and whoever reads that
 * file can be reading a verdict that belongs to another run - a red taken for
 * green or a green taken for red. That path appears nowhere in this repository;
 * it was invented by whoever needed a machine-readable result and wrote the
 * command by hand.
 *
 * `scripts/test-junit.ts` is the sanctioned way to ask for that report, and the
 * whole point of it is the DERIVED path. So the bench that matters is the one
 * below: two concurrent runs, and the two output paths must be distinct.
 * @covers SLOT-02
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { junitOutfilePath, innerTestCommand, junitCommand } from "./test-junit.ts";

const ROOT = join(import.meta.dir, "..");

describe("the path of a junit report", () => {
  it("is different for two runs from the same worktree", () => {
    const now = new Date("2026-08-27T02:40:00.000Z");
    // Same worktree, same instant: only the pid differs, which is exactly the
    // pair that was measured (two runs from one checkout).
    expect(junitOutfilePath(ROOT, 111, now)).not.toBe(junitOutfilePath(ROOT, 222, now));
  });

  it("is different for the same pid used again later", () => {
    const a = junitOutfilePath(ROOT, 111, new Date("2026-08-27T02:40:00.000Z"));
    const b = junitOutfilePath(ROOT, 111, new Date("2026-08-27T02:53:00.000Z"));
    expect(a).not.toBe(b);
  });

  it("is different for two checkouts of the same project", () => {
    const now = new Date("2026-08-27T02:40:00.000Z");
    expect(junitOutfilePath("/w/alpha", 111, now)).not.toBe(junitOutfilePath("/w/beta", 111, now));
  });

  it("stays inside the worktree instead of a shared /tmp", () => {
    const p = junitOutfilePath(ROOT, 111, new Date());
    expect(p.startsWith(join(ROOT, "test-results"))).toBe(true);
    expect(p).not.toContain("/tmp/");
  });
});

describe("the command it derives", () => {
  /**
   * It reads the real `test:unit` instead of spelling the suite out, so the
   * path list and the timeout cannot drift from the script a guard already
   * watches (`tests/unit/test-default-timeout.test.ts`).
   */
  const script = "bun run scripts/slot.ts test:unit -- 'bun test --timeout 30000 ./client/src ./tests/unit'";

  it("unwraps the command the semaphore wrapper wraps", () => {
    expect(innerTestCommand(script)).toBe("bun test --timeout 30000 ./client/src ./tests/unit");
  });

  it("keeps the suite's own flags and adds the reporter", () => {
    const cmd = junitCommand(script, "/w/out.xml", []);
    expect(cmd).toContain("--timeout 30000");
    expect(cmd).toContain("--reporter=junit --reporter-outfile=/w/out.xml");
    expect(cmd).toContain("./client/src ./tests/unit");
  });

  it("replaces the path list when the caller named some files", () => {
    const cmd = junitCommand(script, "/w/out.xml", ["./tests/unit/one.test.ts"]);
    expect(cmd).toContain("./tests/unit/one.test.ts");
    expect(cmd).not.toContain("./client/src");
    expect(cmd, "the timeout knob is not a path and must survive").toContain("--timeout 30000");
  });
});

describe("two concurrent runs of `test:unit:junit`", () => {
  /**
   * TWO REAL PROCESSES, started together, each printing the path it will write.
   * The pure function above cannot answer this: the collision that was measured
   * happened between two OS processes, and what keeps them apart is the pid,
   * which only exists once there are two of them.
   *
   * They are dry runs and not full suites on purpose. The first version of this
   * bench nested a whole `bun test` inside `bun test`: it took 89 seconds and
   * then failed on a stray async error belonging to a completely different test
   * file. What is being measured is the NAME of the report, and the name is
   * decided before a single test runs.
   */
  async function reportPathOf(): Promise<string> {
    const p = Bun.spawn(["bun", "run", "scripts/test-junit.ts", "--dry-run"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited, "the dry run must succeed").toBe(0);
    const lines = out.trim().split("\n").filter((l) => l.trim() !== "");
    return lines[lines.length - 1] ?? "";
  }

  it("write into two DISTINCT files", async () => {
    const [a, b] = await Promise.all([reportPathOf(), reportPathOf()]);
    expect(a, "the script must print the report path as its last line").toContain(".xml");
    expect(b).toContain(".xml");
    expect(a, "two concurrent runs derived the same report path: one verdict would overwrite the other").not.toBe(b);
  }, 60_000);
});
