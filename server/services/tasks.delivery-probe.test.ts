/**
 * The delivery-report verifier asks the repository the report talks about.
 *
 * It used to ask this server's own checkout, whatever the card's project:
 * a dancerooms commit was "in no ref", a file that existed only on the
 * delivery branch "not tracked". Four true deliveries were accused on
 * 2026-09-04 before noon. The service now asks the host where the card's
 * repository is (worktree first, then project) and builds the probe there.
 *
 * @covers KANBAN-11
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";
import type { RepoProbe } from "./deliveryReportChecks";

const silentProbe: RepoProbe = {
  shaExists: () => true,
  migrations: () => [],
  readMigration: () => "",
  fileMatches: () => true,
  readLine: () => null,
  symbolInHistory: () => true,
};

describe("the delivery verifier probes the card's repository", () => {
  let db: Database;
  let s: TaskService;
  const asked: Array<{ taskId: string; projectId: string | undefined; assignedTopicId: string | null }> = [];
  const built: string[] = [];
  const fileMatches: string[] = [];

  beforeEach(() => {
    db = freshDb();
    asked.length = 0; built.length = 0; fileMatches.length = 0;
    s = createTaskService(db, {
      repoRootFor: (args) => { asked.push(args); return args.assignedTopicId ? "/worktrees/of/the-card" : "/projects/of/the-board"; },
      probeFor: (root) => {
        built.push(root);
        return { ...silentProbe, fileMatches: (c) => { fileMatches.push(c); return false; } };
      },
    });
  });

  test("a bound card is checked in its worktree, and the report's file claims go to THAT probe", () => {
    db.run("INSERT INTO topics (id) VALUES ('topic-1')");
    const t = s.create({ projectId: PID, text: "Una card", status: "in_progress" });
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-1' WHERE id = ?", [t.id]);

    s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Nuovo helper in `client/src/lib/terminalActions.ts` con i test accanto." } });

    expect(asked).toEqual([{ taskId: t.id, projectId: PID, assignedTopicId: "topic-1" }]);
    expect(built).toEqual(["/worktrees/of/the-card"]);
    expect(fileMatches).toContain("client/src/lib/terminalActions.ts");
    // The accusation, when there is one, comes from the card's own repository.
    const note = s.get(t.id)!.comments.find((c) => c.kind === "review-note");
    expect(note?.content).toContain("client/src/lib/terminalActions.ts");
  });

  test("an unbound card is checked in the board's project, never in this server's checkout", () => {
    const t = s.create({ projectId: PID, text: "Una card di un altro repo", status: "in_progress" });

    s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Vedi `server/src/field.js`." } });

    expect(asked[0]?.assignedTopicId).toBeNull();
    expect(built).toEqual(["/projects/of/the-board"]);
  });
});
