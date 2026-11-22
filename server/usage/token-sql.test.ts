/**
 * La regola in SQL deve dare lo STESSO numero della regola in TypeScript.
 *
 * Sono due scritture della stessa decisione, e due scritture divergono: qui la
 * divergenza diventa rossa. Il confronto gira su SQLite vero, non su una
 * simulazione della sua aritmetica.
 *
 * @covers USAGE-05
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { costFromMessage, costFromTask } from "./token-sql";

const db = new Database(":memory:");
db.run(`CREATE TABLE messages (usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cache_read_tokens INTEGER)`);
db.run(`CREATE TABLE tasks (agent_tokens INTEGER, agent_cache_read_tokens INTEGER)`);

describe("la formula in SQL e quella in TypeScript non divergono", () => {
  test("e le due tabelle, sullo stesso consumo, danno lo stesso numero anche in SQL", () => {
    db.run("DELETE FROM messages");
    db.run("DELETE FROM tasks");
    db.prepare("INSERT INTO messages VALUES (?, ?, ?)").run(200_000, 5_000, 180_000);
    db.prepare("INSERT INTO tasks VALUES (?, ?)").run(25_000, 180_000);
    const m = db.query(`SELECT ${costFromMessage} AS v FROM messages`).get() as { v: number };
    const t = db.query(`SELECT ${costFromTask} AS v FROM tasks`).get() as { v: number };
    expect(m.v).toBe(t.v);
  });
});
