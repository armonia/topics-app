/**
 * A card opened FOR a channel chat follows that chat's turns (card 97e3951f);
 * a card opened BY a chat, or for an ordinary chat, never does: it would sit in
 * `in_progress` with nobody on it (17/11, 16 cards).
 * @covers KANBAN-05
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { configureChannelOriginCards } from "./channel-origin-cards";
import { recordTurnEnd, recordTurnStart } from "../providers/turn-end-registry";

type Card = { id: string; status: string; origin: string; createdBy: string | null };

/** `chats`: topic id → icon. A channel chat wears a brand icon, an ordinary one does not. */
function setup(cards: Card[]) {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT, session_key TEXT, icon TEXT)`);
  db.run(`CREATE TABLE tasks (id TEXT, project_id TEXT, status TEXT, origin_topic_id TEXT, created_by_topic_id TEXT)`);
  db.run(`INSERT INTO topics VALUES ('chan','sk-chan','Discord')`);
  db.run(`INSERT INTO topics VALUES ('plain','sk-plain','MessageSquare')`);
  for (const c of cards) db.run(`INSERT INTO tasks VALUES (?,?,?,?,?)`, [c.id, "p1", c.status, c.origin, c.createdBy]);
  db.run(`INSERT INTO tasks VALUES ('elsewhere','p1','todo','other',NULL)`);
  const moved: string[] = [];
  const comments: string[] = [];
  const off = configureChannelOriginCards(db, {
    update: ((a: { taskId: string }) => { moved.push(a.taskId); }) as never,
    addComment: ((a: { taskId: string; content: string }) => { comments.push(`${a.taskId}: ${a.content}`); }) as never,
  });
  return { moved, comments, off };
}

describe("channel origin cards", () => {
  test("a turn of the channel chat moves the card the gateway opened for it", () => {
    const { moved, off } = setup([{ id: "c1", status: "todo", origin: "chan", createdBy: null }]);
    recordTurnStart("sk-chan", "turn1");
    off();
    expect(moved).toEqual(["c1"]);
  });

  test("a card the channel chat opened itself with create_task stays in backlog", () => {
    const { moved, off } = setup([{ id: "c1", status: "backlog", origin: "chan", createdBy: "chan" }]);
    recordTurnStart("sk-chan", "turn1");
    off();
    expect(moved).toEqual([]);
  });

  test("a card opened for an ordinary chat is not moved by its turns", () => {
    const { moved, off } = setup([
      { id: "gateway", status: "todo", origin: "plain", createdBy: null },
      { id: "intake", status: "backlog", origin: "plain", createdBy: "plain" },
    ]);
    recordTurnStart("sk-plain", "turn1");
    off();
    expect(moved).toEqual([]);
  });

  test("an error end is written on the in_progress card tied to the channel turn only", () => {
    const { comments, off } = setup([
      { id: "tied", status: "in_progress", origin: "chan", createdBy: null },
      { id: "own", status: "in_progress", origin: "chan", createdBy: "chan" },
    ]);
    recordTurnEnd("sk-chan", { end: "error", detail: "Credit balance is too low" });
    off();
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("tied: ");
    expect(comments[0]).toContain("Credit balance is too low");
  });

  test("an error end of an ordinary chat writes nothing on its cards", () => {
    const { comments, off } = setup([{ id: "c1", status: "in_progress", origin: "plain", createdBy: null }]);
    recordTurnEnd("sk-plain", { end: "error", detail: "Credit balance is too low" });
    off();
    expect(comments).toEqual([]);
  });

  test("a clean end writes nothing", () => {
    const { comments, off } = setup([{ id: "c1", status: "in_progress", origin: "chan", createdBy: null }]);
    recordTurnEnd("sk-chan", { end: "end_turn" });
    off();
    expect(comments).toEqual([]);
  });
});
