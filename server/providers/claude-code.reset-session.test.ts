/**
 * `/clear` su una chat claude-code: la prova che il turno DOPO riparte da zero.
 *
 * Cancellare una riga non è la consegna — la consegna è che lo spawn
 * successivo NON faccia più `--resume` su quella memoria. Quella scelta la
 * prende `getOrCreateClaudeSessionId` con il flag `isNew` (claude-code.ts
 * ~1568: `isNewSession ? ["--session-id", id] : ["--resume", id]`), quindi è
 * lì che si guarda.
 *
 * Il difetto che chiude: `/clear` svuotava la tabella `messages` e chiamava
 * `provider.sendToSession?.(…, "/clear")` — metodo che claude-code non ha. Un
 * no-op silenzioso: la chat spariva dallo schermo e il modello ricordava tutto.
 * (task 2.4 della change chat-claude-code-parity)
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { ClaudeCodeProvider, getOrCreateClaudeSessionId } from "./claude-code";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cc-reset-session-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* già chiuso */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* già sparito */ }
});

/** Una topic minima: `claude_code_sessions.session_key` ha una FK su topics. */
function seedTopic(id: string, sessionKey: string): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(`INSERT OR IGNORE INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, id, id, sessionKey, now, now);
}

function makeProvider(): ClaudeCodeProvider {
  // Il costruttore non fa niente oltre a tenersi la config: nessuno spawn,
  // nessun socket. `start()` di proposito NON viene chiamato — `resetSession`
  // tocca solo il DB e la pool di processi, che qui è vuota.
  return new ClaudeCodeProvider({ name: "claude-code", type: "claude-code" } as never);
}

describe("ClaudeCodeProvider.resetSession", () => {
  test("dopo il reset lo spawn successivo è --session-id (uuid nuovo), non --resume", async () => {
    const sessionKey = "topic:reset01";
    seedTopic("reset01", sessionKey);

    // Primo turno: nasce la sessione (→ `--session-id`).
    const first = getOrCreateClaudeSessionId(sessionKey);
    expect(first.isNew).toBe(true);
    // Turni successivi: si riprende la STESSA (→ `--resume`). È qui che stava
    // la memoria che `/clear` non toccava.
    //
    // Questa riga ha anche scovato un difetto suo: `isNew` si decideva
    // confrontando `created_at === now`, due timestamp ISO al millisecondo.
    // Due chiamate nello stesso millisecondo — che è esattamente quello che
    // succede qui — davano `isNew: true` su una riga che esisteva, e lo spawn
    // sarebbe partito con `--session-id` su un id già usato. Ora `isNew` lo
    // dice l'id che torna dall'upsert, senza orologi di mezzo.
    expect(getOrCreateClaudeSessionId(sessionKey)).toEqual({ id: first.id, isNew: false });

    await makeProvider().resetSession(sessionKey);

    const after = getOrCreateClaudeSessionId(sessionKey);
    expect(after.isNew).toBe(true);
    expect(after.id).not.toBe(first.id);
  });

  test("è idempotente e non inventa righe: resettare due volte, o una sessione che non c'è, non esplode", async () => {
    const provider = makeProvider();
    await provider.resetSession("topic:mai-esistita");
    await provider.resetSession("topic:mai-esistita");
    const rows = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM claude_code_sessions WHERE session_key = ?`)
      .get("topic:mai-esistita") as { n: number };
    expect(rows.n).toBe(0);
  });

  test("resetta SOLO la sessione chiesta — le altre chat non perdono la memoria", async () => {
    seedTopic("vicina", "topic:vicina");
    seedTopic("bersaglio", "topic:bersaglio");
    const vicina = getOrCreateClaudeSessionId("topic:vicina");
    getOrCreateClaudeSessionId("topic:bersaglio");

    await makeProvider().resetSession("topic:bersaglio");

    expect(getOrCreateClaudeSessionId("topic:vicina")).toEqual({ id: vicina.id, isNew: false });
    expect(getOrCreateClaudeSessionId("topic:bersaglio").isNew).toBe(true);
  });
});
