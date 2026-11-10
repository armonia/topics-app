/**
 * A card opened by a channel chat follows that chat's turns (card 97e3951f).
 * @covers KANBAN-05
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { configureChannelOriginCards } from "./channel-origin-cards";
import { recordTurnEnd, recordTurnStart } from "../providers/turn-end-registry";

function setup(status: string) {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT, session_key TEXT)`);
  db.run(`CREATE TABLE tasks (id TEXT, project_id TEXT, status TEXT, origin_topic_id TEXT)`);
  db.run(`INSERT INTO topics VALUES ('t1','sk1')`);
  db.run(`INSERT INTO tasks VALUES ('c1','p1',?,'t1')`, [status]);
  db.run(`INSERT INTO tasks VALUES ('c2','p1','todo','other')`);
  const moved: string[] = [];
  const comments: string[] = [];
  const off = configureChannelOriginCards(db, {
    update: ((a: { taskId: string }) => { moved.push(a.taskId); }) as never,
    addComment: ((a: { content: string }) => { comments.push(a.content); }) as never,
  });
  return { moved, comments, off };
}

describe("channel origin cards", () => {
  test("a turn of the origin chat moves its todo card only", () => {
    const { moved, off } = setup("todo");
    recordTurnStart("sk1", "turn1");
    off();
    expect(moved).toEqual(["c1"]);
  });
  test("an error end is written on the in_progress card", () => {
    const { comments, off } = setup("in_progress");
    recordTurnEnd("sk1", { end: "error", detail: "Credit balance is too low" });
    off();
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("Credit balance is too low");
  });
  test("a clean end writes nothing", () => {
    const { comments, off } = setup("in_progress");
    recordTurnEnd("sk1", { end: "end_turn" });
    off();
    expect(comments).toEqual([]);
  });
});
