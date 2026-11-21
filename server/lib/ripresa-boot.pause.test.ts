/**
 * Door B2 of the project pause: the boot resume of a cut turn does not start
 * while the project of the chat is paused; it is parked and goes again, for
 * that chat alone, on "Continua".
 * @covers USAGE-29
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { riprendiTurniInterrotti, type RouterChat } from "./ripresa-boot";
import { insertRestartNotification } from "./boot-partial-sweep";
import { RESEND_COUNTS_DDL } from "../db/test-schema";
import { heldCount, resetHeldForTests } from "../services/turn-gate";
import { resetTurnEndRegistry } from "../providers/turn-end-registry";
import {
  PAUSED_PROJECT_ID, PAUSED_TOPIC_ID, pauseFixtureProject, pausedProjectDb, resumeFixtureProject,
} from "../../tests/helpers/paused-project";

const SK = `topic:${PAUSED_TOPIC_ID}`;
const nowIso = () => new Date().toISOString();

let db: Database;
let calls: Array<Record<string, unknown>>;

/** A chat whose last turn was cut by a restart: the person's message and the boot's notice. */
function cutChat(): Database {
  const d = pausedProjectDb();
  d.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
    partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
  )`);
  d.run(RESEND_COUNTS_DDL);
  d.run(
    "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, branch_index) VALUES ('m1',?,'user','measure it',0,?,0,0)",
    [SK, nowIso()],
  );
  insertRestartNotification(d as unknown as Parameters<typeof insertRestartNotification>[0], SK, { generateId: () => "notice", now: nowIso });
  return d;
}

const route: RouterChat = async (req) => {
  const body = await req.json() as Record<string, unknown>;
  calls.push(body);
  // Like the chat route: the resent message and an answer that ends cleanly.
  const n = calls.length;
  const order = (db.query("SELECT COALESCE(MAX(sort_order), -1) AS mo FROM messages").get() as { mo: number }).mo;
  db.run("INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, branch_index) VALUES (?,?,'user','measure it',0,?,?,0)", [`u${n}`, SK, nowIso(), order + 1]);
  db.run("INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, branch_index) VALUES (?,?,'assistant','',?,0,?,?,0)", [`a${n}`, SK, JSON.stringify([{ kind: "text", text: "done" }]), nowIso(), order + 2]);
  return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
};

const ctxOf = () => ({ db, getTopicBySessionKey: () => ({ id: PAUSED_TOPIC_ID, archived: false }) });

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await work(); } finally { console.log = log; console.warn = warn; }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  resetHeldForTests();
  resetTurnEndRegistry();
  db = cutChat();
  calls = [];
});

describe("boot resume vs a paused project", () => {
  test("paused: zero resends, the cut row stays untouched, the resume is parked", async () => {
    pauseFixtureProject(db);
    await quietly(() => riprendiTurniInterrotti(ctxOf(), route));
    expect(calls).toHaveLength(0);
    const notice = db.query("SELECT blocks FROM messages WHERE id = 'notice'").get() as { blocks: unknown };
    expect(String(notice.blocks)).not.toContain("ripreso");
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
  });

  test("a repeated sweep while paused parks the same chat once", async () => {
    pauseFixtureProject(db);
    await quietly(() => riprendiTurniInterrotti(ctxOf(), route));
    await quietly(() => riprendiTurniInterrotti(ctxOf(), route));
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
  });

  test("after Continua the parked resume goes out, once", async () => {
    pauseFixtureProject(db);
    await quietly(() => riprendiTurniInterrotti(ctxOf(), route));
    await quietly(async () => { resumeFixtureProject(db); await until(() => calls.length > 0); });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionKey).toBe(SK);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(0);
    // The periodic sweep that follows finds the trace and does not resend again.
    await quietly(() => riprendiTurniInterrotti(ctxOf(), route));
    expect(calls).toHaveLength(1);
  });

  test("a project that was never paused resumes as before", async () => {
    await quietly(() => riprendiTurniInterrotti(ctxOf(), route));
    expect(calls).toHaveLength(1);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(0);
  });
});
