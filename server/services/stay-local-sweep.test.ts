/**
 * The sweep that decides the permanent "this Mac only" pins, on a real
 * sqlite schema (`tasks-test-db.ts`'s `freshDb`, i.e. the migration chain):
 * a mac-only card keeps its pin, a pure-code card loses it and gets exactly
 * one reason line, a second pass writes nothing, and a pin with an expiry is
 * never touched.
 */
import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb, PID } from "./tasks-test-db";
import { decideStayLocal, runStayLocalSweep, STAY_LOCAL_CLEARED_PREFIX } from "./stay-local-sweep";

function pin(
  db: Database,
  id: string,
  text: string,
  opts: { until?: string | null; description?: string | null } = {},
): void {
  db.run(
    "INSERT INTO tasks (id, project_id, text, description, created_at, updated_at, stay_local, stay_local_until) " +
      "VALUES (?, ?, ?, ?, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z', 1, ?)",
    [id, PID, text, opts.description ?? null, opts.until ?? null],
  );
}

const pinOf = (db: Database, id: string) =>
  (db.query("SELECT stay_local, stay_local_until FROM tasks WHERE id = ?").get(id) as {
    stay_local: number;
    stay_local_until: string | null;
  });

const commentsOf = (db: Database, id: string) =>
  db.query("SELECT kind, content FROM task_comments WHERE task_id = ?").all(id) as {
    kind: string;
    content: string;
  }[];

test("a mac-tray card keeps its permanent pin and gets no comment", () => {
  const db = freshDb();
  pin(db, "tray", "Fix the tray icon menu not refreshing");
  const r = runStayLocalSweep(db);
  expect(r).toEqual({ scanned: 1, kept: 1, cleared: 0, skipped: 0 });
  expect(pinOf(db, "tray").stay_local).toBe(1);
  expect(commentsOf(db, "tray")).toHaveLength(0);
});

test("a pure-code card loses the pin and gets exactly one reason comment", () => {
  const db = freshDb();
  pin(db, "code", "Add a retry to the fetch helper", { description: "Flaky under load" });
  const r = runStayLocalSweep(db);
  expect(r).toEqual({ scanned: 1, kept: 0, cleared: 1, skipped: 0 });
  expect(pinOf(db, "code").stay_local).toBe(0);
  const comments = commentsOf(db, "code");
  expect(comments).toHaveLength(1);
  expect(comments[0]!.kind).toBe("service");
  expect(comments[0]!.content.startsWith(STAY_LOCAL_CLEARED_PREFIX)).toBeTrue();
});

test("the reason names the dispatcher when the thread says the dispatcher pinned it", () => {
  const db = freshDb();
  pin(db, "disp", "Add a retry to the fetch helper");
  db.run(
    "INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES ('c1', 'disp', 'system', ?, '2026-11-14T00:00:00Z', 'service')",
    ["La corsa è finita senza nessun commit: la card usa file che stanno solo su questo Mac."],
  );
  runStayLocalSweep(db);
  const written = commentsOf(db, "disp").find((c) => c.content.startsWith(STAY_LOCAL_CLEARED_PREFIX));
  expect(written?.content).toContain("pin messo dal dispatcher");
});

test("running the sweep twice changes nothing the second time", () => {
  const db = freshDb();
  pin(db, "code", "Add a retry to the fetch helper");
  pin(db, "tray", "Fix the tray icon menu not refreshing");
  runStayLocalSweep(db);
  const after = runStayLocalSweep(db);
  expect(after).toEqual({ scanned: 1, kept: 1, cleared: 0, skipped: 0 });
  expect(commentsOf(db, "code")).toHaveLength(1);
});

test("a card re-pinned by hand after the sweep is left alone, reason comment and all", () => {
  const db = freshDb();
  pin(db, "code", "Add a retry to the fetch helper");
  runStayLocalSweep(db);
  db.run("UPDATE tasks SET stay_local = 1 WHERE id = 'code'");
  const again = runStayLocalSweep(db);
  expect(again).toEqual({ scanned: 1, kept: 0, cleared: 0, skipped: 1 });
  expect(pinOf(db, "code").stay_local).toBe(1);
  expect(commentsOf(db, "code")).toHaveLength(1);
});

test("a pin WITH an expiry is never touched", () => {
  const db = freshDb();
  pin(db, "temp", "Add a retry to the fetch helper", { until: "2026-11-20T00:00:00Z" });
  const r = runStayLocalSweep(db);
  expect(r).toEqual({ scanned: 0, kept: 0, cleared: 0, skipped: 0 });
  expect(pinOf(db, "temp").stay_local).toBe(1);
  expect(commentsOf(db, "temp")).toHaveLength(0);
});

test("decideStayLocal: the kept line names the origin and writes nothing by itself", () => {
  const keep = decideStayLocal({ text: "launchd agent stuck" }, []);
  expect(keep.verdict).toBe("keep");
  expect(keep.reason).toContain("non si sa chi abbia messo il pin");
  const clear = decideStayLocal({ text: "rename a helper" }, [
    { kind: "service", content: "«Solo Mac», senza scadenza: pin manuale, nessuna ragione scritta." },
  ]);
  expect(clear.verdict).toBe("clear");
  expect(clear.reason).toContain("pin messo da una persona");
});
