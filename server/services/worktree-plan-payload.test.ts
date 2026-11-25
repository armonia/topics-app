/**
 * The preview list shows the sweep's own reason for a kept worktree, counts the
 * folders outside the root, and names the project of each line.
 *
 * @covers WORKTREE-STD-07
 */
import { describe, expect, test } from "bun:test";
import { toPlanPayload } from "./worktree-plan-payload";
import type { GcPlan } from "./worktree-gc-passes";

const base = { projectId: "p1", rowId: null, bytes: 10 };

describe("toPlanPayload", () => {
  test("maps classes, actions and names, and counts foreign folders", () => {
    const plan = {
      entries: [
        { ...base, absPath: "/r/a/x", cls: "tracked", action: "judge", reason: "judged by the sweep", rowId: "w1", planned: { action: "keep", reason: "worktree has uncommitted changes", slim: false } },
        { ...base, absPath: "/r/a/y", cls: "tracked", action: "judge", reason: "judged by the sweep", rowId: "w2", planned: { action: "reap", reason: "", slim: false } },
        { ...base, absPath: "/e/z", cls: "foreign", action: "inventory", reason: "outside the worktree root", planned: null },
        { ...base, projectId: null, absPath: "/r/g", cls: "ghost", action: "quarantine", reason: "left over", planned: null },
        { ...base, projectId: null, absPath: "/r/.quarantine/2026-11-20/a/g", cls: "quarantined", action: "wait", reason: "in quarantine", planned: null, from: "/r/a/g" },
      ],
      scanMs: 12.6,
      overCap: [{ projectId: "p1", count: 25, max: 20 }],
      settings: { abandonDays: 7, gcForeign: "off", maxPerProject: 20 },
    } as unknown as GcPlan;
    const payload = toPlanPayload(plan, (id) => (id === "p1" ? "Alpha" : null));
    expect(payload.foreignCount).toBe(1);
    expect(payload.scanMs).toBe(13);
    expect(payload.entries[0]).toMatchObject({ projectName: "Alpha", plannedAction: "keep", reason: "worktree has uncommitted changes", rootAction: "judge" });
    expect(payload.entries[1]!.plannedAction).toBe("reap");
    expect(payload.entries[2]).toMatchObject({ cls: "foreign", rowId: null, plannedAction: null });
    expect(payload.entries[3]!.projectName).toBeNull();
    expect(payload.entries[3]!.from).toBeNull();
    expect(payload.entries[4]).toMatchObject({ cls: "quarantined", from: "/r/a/g" });
    expect(payload.overCap[0]).toMatchObject({ projectName: "Alpha", count: 25, max: 20 });
  });
});
