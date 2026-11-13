/**
 * A permanent `stayLocal` (no `stayLocalUntil`) always leaves a reason on
 * the thread, whoever writes it: a person through the API, or the
 * dispatcher's own mac-only-path branch (which carries its own full
 * explanation and must not get a second, generic one on top).
 * @covers card 50a5a6c9-34ca-4ecc-b3f6-4fb76dbe0a21, PR #904 review feedback
 */
import { test, expect } from "bun:test";
import { freshDb, svc, PID } from "./tasks-test-db";

const setup = () => { const db = freshDb(); return { db, s: svc(db) }; };

test("a person's permanent pin with a typed reason records it on the thread", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  s.update({ taskId: t.id, actor: "human", by: "api", patch: { stayLocal: true, stayLocalReason: "usa il tray di questo Mac" } });
  const content = s.get(t.id)!.comments.map((c) => c.content);
  expect(content.some((c) => c.includes("usa il tray di questo Mac"))).toBeTrue();
});

test("a person's permanent pin with no typed reason still gets a generic one, not silence", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  s.update({ taskId: t.id, actor: "human", by: "api", patch: { stayLocal: true } });
  const content = s.get(t.id)!.comments.map((c) => c.content);
  expect(content.some((c) => c.startsWith("«Solo Mac», senza scadenza:"))).toBeTrue();
});

test("a temporary pin (stayLocalUntil set) gets no reason comment: it is not permanent", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  s.update({ taskId: t.id, actor: "agent", by: "dispatcher", patch: { stayLocal: true, stayLocalUntil: "2026-11-20T00:00:00Z" } });
  const content = s.get(t.id)!.comments.map((c) => c.content);
  expect(content.some((c) => c.startsWith("«Solo Mac»"))).toBeFalse();
});

test("the dispatcher's own permanent pin is not doubled up with the generic comment", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human" });
  s.update({ taskId: t.id, actor: "agent", by: "dispatcher", patch: { stayLocal: true } });
  const content = s.get(t.id)!.comments.map((c) => c.content);
  expect(content.filter((c) => c.startsWith("«Solo Mac»")).length).toBe(0);
});

test("a card born pinned from the composer gets its reason at birth", () => {
  const { s } = setup();
  const t = s.create({ projectId: PID, text: "x", status: "todo", createdBy: "human", stayLocal: true, stayLocalReason: "tray + hub :3360" });
  const content = s.get(t.id)!.comments.map((c) => c.content);
  expect(content.some((c) => c.includes("tray + hub :3360"))).toBeTrue();
});
