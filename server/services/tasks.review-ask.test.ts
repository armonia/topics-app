/**
 * A card that reaches review asks the person something (10/11, `solido`: three cards in review with no human_ask).
 * @covers KANBAN-102
 */
import { test, expect } from "bun:test";
import { freshDb, svc, PID } from "./tasks-test-db";

const setup = () => { const db = freshDb(); return { db, s: svc(db) }; };

test("a card moved into review by the API takes the «aspetta: attilio» line as its question", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "nuvola", status: "todo", createdBy: "agent:api", description: "aspetta: attilio — ok a vista sul video?" });
  const r = s.update({ taskId: t.id, actor: "human", by: "api", patch: { status: "review" } });
  expect(r.humanAsk).toBe("ok a vista sul video?");
});

test("a system delivery with no question asks the next move", () => {
  const { db, s } = setup();
  const t = s.create({ projectId: PID, text: "nodo", status: "todo", createdBy: "agent:api" });
  db.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [t.id]);
  const r = s.deliverToReviewBySystem({ taskId: t.id, reason: "Consegnato dal nodo", nextMove: "Guarda il diff e approva, oppure rimandala indietro." });
  expect(r.humanAsk).toBe("Guarda il diff e approva, oppure rimandala indietro.");
});

test("a question already written wins", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  const r = s.update({ taskId: t.id, actor: "human", by: "api", patch: { status: "review", humanAsk: "scegli A o B?" } });
  expect(r.humanAsk).toBe("scegli A o B?");
});

test("leaving review drops the question", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  s.update({ taskId: t.id, actor: "human", by: "api", patch: { status: "review" } });
  const r = s.update({ taskId: t.id, actor: "human", by: "api", patch: { status: "todo" } });
  expect(r.humanAsk ?? null).toBe(null);
});

test("pinning a card to this Mac ends the wait for the old node", () => {
  const { db, s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  db.run("UPDATE tasks SET wait_streak = 3, wait_reason = 'il nodo «pc windows» non è pronto', wait_since = '2026-11-10T10:00:00Z' WHERE id = ?", [t.id]);
  s.update({ taskId: t.id, actor: "agent", by: "dispatcher", patch: { machineId: null, stayLocal: true, stayLocalUntil: "2026-11-11T10:00:00Z" } });
  const r = db.query("SELECT wait_reason, wait_since, wait_streak FROM tasks WHERE id = ?").get(t.id) as any;
  expect(r).toEqual({ wait_reason: null, wait_since: null, wait_streak: 0 });
});
