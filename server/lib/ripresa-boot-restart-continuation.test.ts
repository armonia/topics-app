/**
 * A restart that cuts a chat turn at work: the boot continues it, it does not
 * resend the question, and it spends no attempt. The gate now cuts such turns
 * after the chat cap instead of deferring the restart for hours
 * (`turnSurvivesRestart`, topic:d740f8ae on 03/10), so this is what keeps a
 * long chat from hitting the resume cap after four planned restarts.
 *
 * @covers RESUME-01, RGATE-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_RESUME_ATTEMPTS, cutTurnProgressed, restartContinuationNote, riprendiTurniInterrotti,
} from "./ripresa-boot";
import { RESEND_COUNTS_DDL } from "../db/test-schema";
import { recordResend } from "./resend-count";
import { RESTART_INTERRUPTED_MARKER } from "./boot-partial-sweep";
import type { ContentBlock } from "../types";

const SK = "topic:continua";
const tool = (status: string): ContentBlock => ({
  kind: "tool", toolCall: { id: `t-${status}`, name: "bash", args: { command: "make" }, status: status as never },
});
const restartCut: ContentBlock = { kind: "error", text: RESTART_INTERRUPTED_MARKER };
const shutdownCut = { kind: "error", text: "Turno interrotto: il server si è riavviato.", cause: "server-shutdown" } as ContentBlock;
const watchdogCut = {
  kind: "error", text: "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.", cause: "watchdog",
} as ContentBlock;

function chatDb(answer: ContentBlock[], spent = 0): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
    partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER, end_reason TEXT, latency_ms INTEGER
  )`);
  db.run(RESEND_COUNTS_DDL);
  db.run("CREATE TABLE activity_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, session_key TEXT)");
  db.run("CREATE TABLE compaction_markers (id TEXT PRIMARY KEY, session_key TEXT, after_message_id TEXT, trigger TEXT)");
  const at = (ago: number) => new Date(Date.now() - ago).toISOString();
  db.run("INSERT INTO messages VALUES ('u0', ?, 'user', 'costruisci il livello', NULL, 0, ?, 0, NULL, 0, NULL, NULL)", [SK, at(20 * 60_000)]);
  db.run("INSERT INTO messages VALUES ('a0', ?, 'assistant', '', ?, 0, ?, 1, 'u0', 0, 'cut-by-restart', NULL)", [SK, JSON.stringify(answer), at(60_000)]);
  if (spent > 0) recordResend(db, SK, { messageId: "u0", attempts: spent, freeProbes: 0 });
  return db;
}

async function sweep(db: Database): Promise<Array<{ messages: Array<{ content: string }>; ripresa: number; resendOf: string }>> {
  const bodies: Array<{ messages: Array<{ content: string }>; ripresa: number; resendOf: string }> = [];
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    await riprendiTurniInterrotti(
      {
        db, getTopicBySessionKey: () => ({ archived: false }),
        backgroundCommands: () => [{ description: "route_pipe.sh route-v6", processId: "proc-42" }],
      },
      async (req: Request) => {
        bodies.push(await req.json());
        return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
      },
      { responseMs: 500, streamMs: 500 },
    );
  } finally { console.log = log; console.warn = warn; }
  return bodies;
}

describe("a restart that cut a turn at work", () => {
  test("is continued with the note, even with every attempt already spent", async () => {
    const bodies = await sweep(chatDb([tool("success"), restartCut], MAX_RESUME_ATTEMPTS));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages[0].content).toBe(restartContinuationNote([{ description: "route_pipe.sh route-v6", processId: "proc-42" }]));
    expect(bodies[0].ripresa).toBe(1);
    expect(bodies[0].resendOf).toBe("u0");
  });

  test("the graceful shutdown's cut counts as a restart too", async () => {
    const bodies = await sweep(chatDb([tool("error"), shutdownCut], MAX_RESUME_ATTEMPTS));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].ripresa).toBe(1);
  });

  test("a turn that did nothing is resent as before, and spends an attempt", async () => {
    const bodies = await sweep(chatDb([tool("running"), restartCut], 1));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages[0].content).toBe("costruisci il livello");
    expect(bodies[0].ripresa).toBe(2);
  });

  test("no loop: with nothing done and the attempts spent, it stops", async () => {
    expect(await sweep(chatDb([tool("running"), restartCut], MAX_RESUME_ATTEMPTS))).toHaveLength(0);
  });

  test("work cut by something other than a restart still spends its attempts", async () => {
    expect(await sweep(chatDb([tool("success"), watchdogCut], MAX_RESUME_ATTEMPTS))).toHaveLength(0);
  });
});

describe("the pieces", () => {
  test("progress is a tool with an outcome, not one still running or a text", () => {
    expect(cutTurnProgressed([[tool("success")]])).toBe(true);
    expect(cutTurnProgressed([null, [tool("error")]])).toBe(true);
    expect(cutTurnProgressed([[tool("running"), { kind: "text", text: "sto per" }]])).toBe(false);
    expect(cutTurnProgressed([])).toBe(false);
  });

  test("the note says the restart, the commands still alive, and to go on", () => {
    const none = restartContinuationNote([]);
    expect(none).toContain("server restarted in the middle of your previous turn");
    expect(none).toContain("No background command of this chat is still running");
    expect(restartContinuationNote([{ description: "build", processId: "p1" }])).toContain("still running: build (p1)");
  });
});
