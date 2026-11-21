/** @covers KANBAN-73 */
import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb } from "../routes/tasks-test-support";
import type { AIProvider } from "../providers";
import { forYouSweep } from "./task-for-you";

const answer = JSON.stringify({ asked: "Niente: va solo chiusa.", happened: "Tornava sempre uguale.", done: "Ho solo guardato.", remains: "Chiuderla.", options: ["Chiudila"] });
const fake = (content: string, calls: string[] = []): AIProvider => ({
  complete: async (messages: { content: string }[]) => { calls.push(messages[0].content); return { content }; },
}) as unknown as AIProvider;

let db: Database;
beforeEach(() => {
  db = freshDb();
  db.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, review_at) VALUES ('a','p1','Controllo','review','t','t','2026-11-11T10:00:00Z')").run();
  db.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES ('b','p1','Altro','todo','t','t')").run();
});

describe("forYouSweep", () => {
  test("summarises only cards in review, once, and again when a comment arrives", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    expect(await forYouSweep(db, () => fake(answer, calls), (id) => seen.push(id))).toEqual(["a"]);
    expect(JSON.parse((db.query("SELECT for_you FROM tasks WHERE id='a'").get() as { for_you: string }).for_you).asked).toBe("Niente: va solo chiusa.");
    expect(await forYouSweep(db, () => fake(answer, calls), () => {})).toEqual([]);
    db.query("INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES ('c','a','user','ok','2026-11-11T11:00:00Z')").run();
    expect(await forYouSweep(db, () => fake(answer, calls), () => {})).toEqual(["a"]);
    expect(calls).toHaveLength(2);
    expect(seen).toEqual(["a"]);
  });
  test("a model answer with jargon writes nothing and is retried", async () => {
    const bad = answer.replace("Ho solo guardato.", "Vedi server/foo.ts");
    expect(await forYouSweep(db, () => fake(bad), () => {})).toEqual([]);
    expect((db.query("SELECT for_you FROM tasks WHERE id='a'").get() as { for_you: string | null }).for_you).toBeNull();
  });
  test("no provider, no summary", async () => {
    expect(await forYouSweep(db, () => null, () => {})).toEqual([]);
  });
});
