/**
 * A guest's write capability on a shared task: `comment` and `edit` gate the
 * two writes this router opens to a guest at all (see
 * `matchGuestTaskAction`), and no level reaches a run, a stop, or any other
 * owner-only route (retitle, land, publish, ...).
 *
 * @covers GUEST-09
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createTasksRouter, matchGuestTaskAction } from "./tasks";
import { putGrant, dropGrant } from "../lib/grants-query";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const ROOT = join(import.meta.dir, "..", "..");

// The real chain, up to and including ours: 080 creates `devices`, 082/083
// bring `grants` from `task_shares`, 084 adds people/orgs, 20260816230500
// widens `resource_type` to `project`. Running the real predecessors instead
// of a hand-rolled schema is what `orgs.test.ts` already does — copied here
// so a future CHECK drifting from the TypeScript union fails a test, not a
// guest in production.
const MIGRATIONS = [
  "080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql",
  "20260816230500-grants-project.sql", "20260909180634-grant-levels-write-scope.sql",
];

function withGrants(db: Database): void {
  for (const m of MIGRATIONS) db.run(readFileSync(join(ROOT, "server/db/migrations", m), "utf8"));
}

function guestCtx(db: Database, broadcasts: unknown[], deviceId: string) {
  const base = makeCtx(db, broadcasts);
  return { ...base, requestIdentity: () => ({ role: "guest" as const, deviceId }) } as unknown as AppContext;
}

describe("matchGuestTaskAction - the two guest writes, and nothing else", () => {
  test("read on the item itself, and only the item", () => {
    expect(matchGuestTaskAction("/api/tasks/t1", "t1", "GET")).toBe("read");
    expect(matchGuestTaskAction("/api/tasks/t1/comments", "t1", "GET")).toBe("unsupported");
  });
  test("comment and edit, each its own subpath", () => {
    expect(matchGuestTaskAction("/api/tasks/t1/comments", "t1", "POST")).toBe("comment");
    expect(matchGuestTaskAction("/api/tasks/t1", "t1", "PATCH")).toBe("edit");
  });
  test("run and stop are unsupported: no level on this scale dispatches an agent", () => {
    expect(matchGuestTaskAction("/api/tasks/t1/run", "t1", "POST")).toBe("unsupported");
    expect(matchGuestTaskAction("/api/tasks/t1/stop", "t1", "POST")).toBe("unsupported");
  });
  test("everything else on this router is unsupported for a guest, at any level", () => {
    expect(matchGuestTaskAction("/api/tasks/t1/land", "t1", "POST")).toBe("unsupported");
    expect(matchGuestTaskAction("/api/tasks/t1/retitle", "t1", "POST")).toBe("unsupported");
    expect(matchGuestTaskAction("/api/tasks/t1", "t1", "DELETE")).toBe("unsupported");
  });
});

describe("a guest with a level on a shared task", () => {
  let db: Database; let broadcasts: any[]; let owner: any; let taskId: string;
  beforeEach(async () => {
    db = freshDb(); broadcasts = [];
    withGrants(db);
    owner = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(owner, "POST", "/api/sessions/s1/tasks", { text: "shared card" }))!.json();
    taskId = t.id;
  });

  test("`read` only: sees the task, cannot comment", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "read", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const got = await (await call(guest, "GET", `/api/tasks/${taskId}`))!.json();
    expect(got.id).toBe(taskId);
    const denied = (await call(guest, "POST", `/api/tasks/${taskId}/comments`, { content: "hi" }))!;
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("guest_level_denied");
  });

  test("`comment`: can comment, cannot edit the text", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "comment", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const posted = (await call(guest, "POST", `/api/tasks/${taskId}/comments`, { content: "looks good" }))!;
    expect(posted.status).toBe(200);
    expect(broadcasts.some((b) => b.type === "task:updated")).toBe(true);
    const denied = (await call(guest, "PATCH", `/api/tasks/${taskId}`, { text: "renamed" }))!;
    expect(denied.status).toBe(403);
  });

  test("`edit`: can rename the card, and STILL cannot start it", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "edit", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const edited = (await call(guest, "PATCH", `/api/tasks/${taskId}`, { text: "renamed by guest" }))!;
    expect(edited.status).toBe(200);
    expect((await edited.json()).text).toBe("renamed by guest");
    // The pair that made `run` unacceptable: rewrite the text, then dispatch it
    // as a prompt inside the owner's repository. The second half is refused at
    // the TOP level of the scale, so the pair cannot be assembled at all.
    for (const route of ["run", "stop"]) {
      const denied = (await call(guest, "POST", `/api/tasks/${taskId}/${route}`))!;
      expect(denied.status).toBe(403);
      expect((await denied.json()).code).toBe("guest_read_only");
    }
    // And nothing was dispatched: the card is still where the edit left it.
    expect(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId)).toMatchObject({ status: "backlog" });
  });

  test("`edit` still cannot reach an owner-only route", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "edit", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const denied = (await call(guest, "POST", `/api/tasks/${taskId}/land`))!;
    expect(denied.status).toBe(403);
  });

  test("a `deny` beats any level, including the ones granted to the guest's own device", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "edit", grantedAt: Date.now() });
    // A level change is drop-then-put, same as the sharing UI does — the
    // UNIQUE(subject, resource) index would otherwise silently ignore the
    // second row.
    dropGrant(db, { kind: "device", id: "g1" }, "task", taskId);
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "deny", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const denied = (await call(guest, "GET", `/api/tasks/${taskId}`))!;
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("not_shared");
  });
});
