/**
 * A collaborator's comment resolves to a real person + device, scoped by the
 * same grant the write itself required — no new endpoint, no new leak.
 * @covers COLLAB-01, COLLAB-02
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { putGrant } from "../lib/grants-query";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const ROOT = join(import.meta.dir, "..", "..");
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

describe("a guest comment resolves to person + device", () => {
  let db: Database; let broadcasts: any[]; let owner: any; let taskId: string;
  beforeEach(async () => {
    db = freshDb(); broadcasts = [];
    withGrants(db);
    const now = Date.now();
    db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["p1", "Collaboratrice", now, now]);
    db.run("INSERT INTO devices (id, name, token_hash, created_at, person_id) VALUES (?, ?, ?, ?, ?)", ["g1", "Laptop ospite", "hash1", now, "p1"]);
    owner = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(owner, "POST", "/api/sessions/s1/tasks", { text: "shared card" }))!.json();
    taskId = t.id;
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "comment", grantedAt: now });
  });

  test("the comment carries the person and device that wrote it, not `guest:<id>`", async () => {
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    await call(guest, "POST", `/api/tasks/${taskId}/comments`, { content: "looks good" });
    const got = await (await call(guest, "GET", `/api/tasks/${taskId}`))!.json();
    const comment = got.comments.find((c: any) => c.content === "looks good");
    expect(comment.actorPersonName).toBe("Collaboratrice");
    expect(comment.actorDeviceName).toBe("Laptop ospite");
  });

  test("the task itself carries the most recent collaborator's identity, for the board card and the filters", async () => {
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    await call(guest, "POST", `/api/tasks/${taskId}/comments`, { content: "looks good" });
    const got = await (await call(guest, "GET", `/api/tasks/${taskId}`))!.json();
    expect(got.lastActorPersonName).toBe("Collaboratrice");
    expect(got.lastActorDeviceName).toBe("Laptop ospite");
  });

  test("a task nobody has commented on carries no actor — an empty state, not a guess", async () => {
    const bare = await (await call(owner, "POST", "/api/sessions/s1/tasks", { text: "solo card" }))!.json();
    putGrant(db, { kind: "device", id: "g1" }, "task", bare.id, { level: "read", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const got = await (await call(guest, "GET", `/api/tasks/${bare.id}`))!.json();
    expect(got.lastActorPersonName).toBe(null);
  });

  test("a device with no grant at all still cannot read the task — the activity summary opens no new door", async () => {
    const stranger = createTasksRouter(guestCtx(db, broadcasts, "g2"));
    const denied = (await call(stranger, "GET", `/api/tasks/${taskId}`))!;
    expect(denied.status).toBe(403);
  });
});
