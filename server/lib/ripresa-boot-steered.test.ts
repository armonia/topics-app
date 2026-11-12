/**
 * A STEERED ROW IS NEVER THE MESSAGE A CUT TURN RESENDS.
 *
 * A message steered into a running turn (CHAT-QUEUE-08) is stored after that
 * turn's assistant row, and the model already read it. When the turn is then
 * cut (restart, shutdown, API down, broker dead, watchdog), the sweep must
 * resend what it would have resent without the steered row (the continuation
 * note, or the person's message), never the steered words: the second review
 * of the steer found the sweep resending "usa la porta 2222" in all five cases.
 * And a turn that was answered stays answered, steered row or not.
 * @covers CHAT-QUEUE-08
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cutTurnResumable, riprendiTurniInterrotti } from "./ripresa-boot";
import { RESEND_COUNTS_DDL } from "../db/test-schema";
import { RESTART_INTERRUPTED_MARKER } from "./boot-partial-sweep";
import { INTERRUPTED_MARKER } from "./stale-stream-sweep";

const SK = "topic:steered-cut";
const tool = { kind: "tool", toolCall: { id: "toolu_1", name: "bash", args: {}, status: "success" } };

function chatDb(cut: unknown | null, withSteered: boolean): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT, partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER, end_reason TEXT, latency_ms INTEGER)`);
  db.run(RESEND_COUNTS_DDL);
  db.run("CREATE TABLE activity_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, session_key TEXT)");
  db.run("CREATE TABLE compaction_markers (id TEXT PRIMARY KEY, session_key TEXT, after_message_id TEXT, trigger TEXT)");
  const at = (ago: number) => new Date(Date.now() - ago).toISOString();
  db.run("INSERT INTO messages VALUES ('u0', ?, 'user', 'costruisci il livello', NULL, 0, ?, 0, NULL, 0, NULL, NULL)", [SK, at(20 * 60_000)]);
  const blocks = cut ? [{ kind: "text", text: "sto lavorando" }, tool, cut] : [{ kind: "text", text: "fatto" }];
  db.run("INSERT INTO messages VALUES ('a0', ?, 'assistant', ?, ?, 0, ?, 1, 'u0', 0, ?, NULL)", [SK, cut ? "sto lavorando" : "fatto", JSON.stringify(blocks), at(60_000), cut ? "error" : "done"]);
  if (withSteered) {
    db.run("INSERT INTO messages VALUES ('us', ?, 'user', 'usa la porta 2222', ?, 0, ?, 2, 'a0', 0, NULL, NULL)", [SK, JSON.stringify([{ kind: "steered", into: "a0" }]), at(30_000)]);
  }
  return db;
}

const ctxOf = (db: Database) => ({ db, getTopicBySessionKey: () => ({ archived: false }), backgroundCommands: () => [] });

async function sweep(db: Database): Promise<Array<{ content: string; resendOf: unknown }>> {
  const bodies: Array<{ messages: Array<{ content: unknown }>; resendOf?: unknown }> = [];
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    await riprendiTurniInterrotti(
      ctxOf(db) as never,
      async (req: Request) => {
        bodies.push(await req.json() as never);
        return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
      },
      { responseMs: 500, streamMs: 500 },
    );
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return bodies.map((b) => ({ content: String(b.messages[0]!.content), resendOf: b.resendOf }));
}

const cuts: Record<string, unknown> = {
  "a restart": { kind: "error", text: RESTART_INTERRUPTED_MARKER },
  "a graceful shutdown": { kind: "error", text: "Turno interrotto: il server si è riavviato.", cause: "server-shutdown" },
  "the API down": { kind: "error", text: "L'API non risponde", cause: "api-unavailable" },
  "a dead broker": { kind: "error", text: "Il broker è morto", cause: "broker-died" },
  "the watchdog": { kind: "error", text: INTERRUPTED_MARKER.replace(/^⚠️\s*/, ""), cause: "watchdog" },
};

describe("a turn cut after a message was steered into it", () => {
  for (const [name, cut] of Object.entries(cuts)) {
    test(`after ${name}, the sweep resends what it would without the steered row`, async () => {
      const without = await sweep(chatDb(cut, false));
      const withSteered = await sweep(chatDb(cut, true));
      expect(without.length).toBe(1);
      expect(withSteered).toEqual(without);
      expect(withSteered[0]!.content).not.toContain("usa la porta 2222");
    });
  }

  test("an answered turn stays answered: nothing resent, not resumable", async () => {
    const db = chatDb(null, true);
    const { log } = console;
    console.log = () => {};
    try {
      expect(await cutTurnResumable(ctxOf(db) as never, SK)).toBe(false);
    } finally {
      console.log = log;
    }
    expect(await sweep(chatDb(null, true))).toEqual([]);
  });
});
