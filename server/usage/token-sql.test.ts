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
import { contextTokens, costTokens, partsFromMessage, partsFromTask } from "../../shared/token-cost";
import { contextFromMessage, contextFromTask, costFromMessage, costFromTask } from "./token-sql";

const db = new Database(":memory:");
db.run(`CREATE TABLE messages (usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cache_read_tokens INTEGER)`);
db.run(`CREATE TABLE tasks (agent_tokens INTEGER, agent_cache_read_tokens INTEGER)`);

const CASI = [
  { prompt: 200_000, completion: 5_000, cacheRead: 180_000 },
  { prompt: 0, completion: 0, cacheRead: 0 },
  { prompt: 100, completion: 10, cacheRead: 5_000 },   // riga vecchia: rilettura > prompt
  { prompt: 1_000, completion: 2_000, cacheRead: 0 },
  { prompt: null, completion: null, cacheRead: null }, // colonne mai scritte
];

describe("la formula in SQL e quella in TypeScript non divergono", () => {
  for (const c of CASI) {
    const nome = `prompt=${c.prompt} completion=${c.completion} cacheRead=${c.cacheRead}`;

    test(`messages · ${nome}`, () => {
      db.run("DELETE FROM messages");
      db.prepare("INSERT INTO messages VALUES (?, ?, ?)").run(c.prompt, c.completion, c.cacheRead);
      const sql = db.query(`SELECT ${costFromMessage} AS costo, ${contextFromMessage} AS contesto FROM messages`).get() as { costo: number; contesto: number };
      const parts = partsFromMessage({
        usagePromptTokens: c.prompt, usageCompletionTokens: c.completion, cacheReadTokens: c.cacheRead,
      });
      expect(Math.round(sql.costo)).toBe(costTokens(parts));
      expect(Math.round(sql.contesto)).toBe(contextTokens(parts));
    });

    test(`tasks · ${nome}`, () => {
      // Le colonne di `tasks` portano le parti già separate: il fatturabile è
      // il prompt SENZA la rilettura, più il completion.
      const billable = Math.max(0, (c.prompt ?? 0) - (c.cacheRead ?? 0)) + (c.completion ?? 0);
      db.run("DELETE FROM tasks");
      db.prepare("INSERT INTO tasks VALUES (?, ?)").run(billable, c.cacheRead);
      const sql = db.query(`SELECT ${costFromTask} AS costo, ${contextFromTask} AS contesto FROM tasks`).get() as { costo: number; contesto: number };
      const parts = partsFromTask({ agentTokens: billable, agentCacheReadTokens: c.cacheRead });
      expect(Math.round(sql.costo)).toBe(costTokens(parts));
      expect(Math.round(sql.contesto)).toBe(contextTokens(parts));
    });
  }

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
