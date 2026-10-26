/**
 * token-before-after gira davvero su un DB temporaneo: il cut divide le righe,
 * le righe non misurate restano fuori e i numeri sono fatti a mano qui sotto.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "token-before-after.ts");
const CUT = "2026-10-26T15:00:00.000Z";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "token-before-after-"));
  dbPath = join(dir, "topics.db");
  const db = new Database(dbPath);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_key TEXT, role TEXT, partial INTEGER DEFAULT 0, timestamp TEXT,
    usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cost_cents INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_creation_1h_tokens INTEGER)`);
  const insert = db.prepare(`INSERT INTO messages VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Prima: due turni da 100k di prompt, metà letta dalla cache.
  insert.run("b1", "assistant", 0, "2026-10-26T10:00:00.000Z", 100_000, 1_000, 50, 50_000, 10_000, 0);
  insert.run("b2", "assistant", 0, "2026-10-26T14:59:59.999Z", 100_000, 3_000, 70, 50_000, 10_000, 0);
  // Dopo: un turno da 60k, quasi tutto riletto, scrittura a un'ora.
  insert.run("a1", "assistant", 0, CUT, 60_000, 2_000, 20, 54_000, 0, 5_000);
  // Fuori conto: utente, parziale, non misurato, fuori finestra.
  insert.run("u1", "user", 0, "2026-10-26T16:00:00.000Z", 1, 1, 1, 1, 1, 1);
  insert.run("p1", "assistant", 1, "2026-10-26T16:00:00.000Z", 999_999, 1, 1, 0, 0, 0);
  insert.run("n1", "assistant", 0, "2026-10-26T16:00:00.000Z", null, 1, 1, null, null, null);
  insert.run("o1", "assistant", 0, "2026-10-20T16:00:00.000Z", 999_999, 1, 1, 0, 0, 0);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...extra: string[]) {
  return Bun.spawnSync(["bun", SCRIPT, "--db", dbPath, ...extra], { stdout: "pipe", stderr: "pipe" });
}

describe("token-before-after", () => {
  it("divide al cut e conta solo i turni misurati", () => {
    const out = run("--cut", CUT, "--hours", "24", "--json");
    expect(out.exitCode).toBe(0);
    const { before, after } = JSON.parse(out.stdout.toString());

    expect(before.turns).toBe(2);
    expect(before.prompt).toBe(100_000);
    expect(before.fresh).toBe(40_000);
    expect(before.cacheRead).toBe(50_000);
    expect(before.output).toBe(2_000);
    // 50k fresco+scritto + 2k output + 0,1 × 50k riletti.
    expect(before.costTokens).toBe(57_000);
    expect(before.costCents).toBe(60);
    expect(before.cacheHitShare).toBe(0.5);

    expect(after.turns).toBe(1);
    expect(after.fresh).toBe(1_000);
    expect(after.cacheWrite1h).toBe(5_000);
    expect(after.costTokens).toBe(6_000 + 2_000 + 5_400);
    expect(after.cacheHitShare).toBe(0.9);
  });

  it("un cut senza fuso è UTC, come le colonne", () => {
    const out = run("--cut", "2026-10-26T15:00:00", "--hours", "24", "--json");
    expect(JSON.parse(out.stdout.toString()).cut).toBe(CUT);
  });

  it("senza --cut si ferma e dice perché", () => {
    const out = run();
    expect(out.exitCode).toBe(1);
    expect(out.stderr.toString()).toContain("--cut");
  });

  it("la tabella esce anche senza --json", () => {
    const out = run("--cut", CUT, "--hours", "24");
    expect(out.exitCode).toBe(0);
    expect(out.stdout.toString()).toContain("quota cache del prompt");
  });
});
