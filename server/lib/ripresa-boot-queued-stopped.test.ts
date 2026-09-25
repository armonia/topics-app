/**
 * The resume sweep against a send still queued on the provider, a message the
 * person stopped, and notices that blamed a restart nobody had. Split from
 * `ripresa-boot.test.ts`, which holds the rest of the rule.
 *
 * @covers RESUME-01, RESUME-02
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_RESUME_ATTEMPTS, RESUME_CAP_MARKER, UNANSWERED_NOTICE, attemptsOnRow, riprendiTurniInterrotti,
  resumeVerdict,
} from "./ripresa-boot";
// The notice builders are new: reached through the namespace so this file still
// loads on the code before the fix, where the verdict tests must fail on the
// verdict and not on a missing import.
import * as boot from "./ripresa-boot";
import { abortLogTitle, eCartelloDiInterruzione } from "./cancelled-notice";
import { RESTART_INTERRUPTED_MARKER } from "./boot-partial-sweep";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { logStreamAborted } from "../db/activity-log";
// `logStopPressed` is new: through the namespace, like the builders above.
import * as activityLog from "../db/activity-log";
import { decodeCol } from "../../shared/message-blob";
import { recordTurnEnd, resetTurnEndRegistry } from "../providers/turn-end-registry";
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import type { ContentBlock } from "../types";

// The sweep reads each session's last turn end from a process-wide registry:
// an end left by another test, or another file in the same shard, would
// decide a verdict here.
beforeEach(() => resetTurnEndRegistry());

/** The row `resumeVerdict` judges. */
type JudgedRow = Parameters<typeof resumeVerdict>[0];

const ORA = Date.UTC(2026, 8, 24, 12, 47, 0);
const interruptedBlock: ContentBlock = { kind: "error", text: "Turno interrotto: il server si è riavviato." };
const proseBlock: ContentBlock = { kind: "text", text: "stavo misurando" };
const base: JudgedRow = {
  sessionKey: "topic:3019832f",
  ruolo: "assistant",
  blocks: [proseBlock, interruptedBlock],
  timestampMs: ORA - 60_000,
  attempts: 0,
};

/**
 * A SEND STILL IN FLIGHT IS NOT AN INTERRUPTION, AND NEITHER IS A STOP.
 *
 * Two chats measured on 24/09, both resent by a sweep that only asked whether
 * a stream was live:
 *
 * (a) topic 3019832f. The watchdog closed a turn whose process was already
 *     dead, while the original send was still waiting in claude-code's
 *     per-session queue. No stream, no live process, and the verdict said
 *     "resend" four times, one every seven minutes: four duplicate user rows,
 *     each one more CLI turn queued behind the stuck one.
 * (b) topic c5d57a41. The person pressed Stop, the empty turn was discarded,
 *     and the last row stayed their message. Four minutes later the
 *     unanswered branch sent it again, and a real git merge ran.
 *
 * @covers RESUME-01
 */
describe("the verdict asks the provider and remembers the Stop", () => {
  const watchdogCut = {
    kind: "error",
    text: "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.",
    cause: "watchdog",
  } as ContentBlock;
  const cutByWatchdog: JudgedRow = { ...base, blocks: [proseBlock, watchdogCut] };
  // 230 s: past USER_TAIL_GRACE_MS, the age the c5d57a41 message had when it was resent.
  const userTail: JudgedRow = { ...base, ruolo: "user", blocks: null, timestampMs: ORA - 230_000 };

  test("(a) a send still queued on the provider: no resend, and no cap notice either", () => {
    expect(resumeVerdict(cutByWatchdog, ORA)).toBe("resend");
    expect(resumeVerdict({ ...cutByWatchdog, providerBusy: true }, ORA)).toBe("no");
    expect(resumeVerdict({ ...cutByWatchdog, providerBusy: true, attempts: MAX_RESUME_ATTEMPTS }, ORA)).toBe("no");
    expect(resumeVerdict({ ...userTail, providerBusy: true }, ORA)).toBe("no");
  });

  test("(b) Stop pressed after the message was written: the message is not sent again", () => {
    expect(resumeVerdict(userTail, ORA)).toBe("unanswered");
    const stop = { info: cancelled("user", "POST /api/chat/abort"), atMs: ORA - 225_000 };
    expect(resumeVerdict({ ...userTail, lastTurnEnd: stop }, ORA)).toBe("no");
    // Past the cap too: a stopped message does not earn a cap notice.
    expect(resumeVerdict({ ...userTail, lastTurnEnd: stop, attempts: MAX_RESUME_ATTEMPTS }, ORA)).toBe("no");
  });

  test("(b) a Stop from BEFORE the message belongs to the turn before, and does not silence this one", () => {
    const staleStop = { info: cancelled("user"), atMs: ORA - 300_000 };
    expect(resumeVerdict({ ...userTail, lastTurnEnd: staleStop }, ORA)).toBe("unanswered");
    // An end that is not a person's Stop does not block the resend.
    const watchdogEnd = { info: cancelled("watchdog"), atMs: ORA - 225_000 };
    expect(resumeVerdict({ ...userTail, lastTurnEnd: watchdogEnd }, ORA)).toBe("unanswered");
  });

  /**
   * A manual /compact ends with an empty result: the chat route discards the
   * empty answer row, the person's '/compact' stays the last row, and the turn
   * end is `end_turn`. That message was answered, and resending it buys a
   * second compaction under a false "no answer arrived" notice.
   */
  test("(d) a normal end recorded after the message: answered with an empty answer, not resent", () => {
    const normalEnd = { info: { end: "end_turn" } as const, atMs: ORA - 225_000 };
    expect(resumeVerdict({ ...userTail, lastTurnEnd: normalEnd }, ORA)).toBe("no");
    // Past the cap too: an answered message earns no cap notice.
    expect(resumeVerdict({ ...userTail, lastTurnEnd: normalEnd, attempts: MAX_RESUME_ATTEMPTS }, ORA)).toBe("no");
    // A normal end from BEFORE the message belongs to the turn before it.
    expect(resumeVerdict({ ...userTail, lastTurnEnd: { ...normalEnd, atMs: ORA - 300_000 } }, ORA)).toBe("unanswered");
    // An error is not an answer: the message is still resent.
    const errorEnd = { info: { end: "error", cause: "provider-error" } as const, atMs: ORA - 225_000 };
    expect(resumeVerdict({ ...userTail, lastTurnEnd: errorEnd }, ORA)).toBe("unanswered");
  });
});

/**
 * A LATE ANSWER SAVED UNDER THE VERDICT IS AN ANSWER.
 *
 * A turn the watchdog closed while its send still waited in the queue gets
 * answered once the queue drains, and that answer is saved on the turn's own
 * row, under the interruption block. Read as "cut", that row made the next
 * sweep resend a message the CLI had already executed (the 3019832f shape,
 * where the message was a real merge). Only the LAST verdict counts: a resumed
 * row opens with its `ripreso` trace and closes with its own verdict when it
 * is cut again.
 *
 * @covers RESUME-01
 */
describe("content after the last interruption verdict means the turn was answered", () => {
  const watchdogCut = {
    kind: "error",
    text: "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.",
    cause: "watchdog",
  } as ContentBlock;
  const lateText: ContentBlock = { kind: "text", text: "merge fatto" };
  const lateTool = { kind: "tool", toolCall: { id: "t", name: "Bash", args: {}, status: "success" } } as ContentBlock;
  const row = (blocks: ContentBlock[], attempts = 0): JudgedRow => ({ ...base, blocks, attempts });

  test("a cut with nothing produced after it is resent", () => {
    expect(resumeVerdict(row([proseBlock, watchdogCut]), ORA)).toBe("resend");
    // The resend trace and blank text are not an answer.
    expect(resumeVerdict(row([watchdogCut, { kind: "ripreso", attempt: 1 } as ContentBlock]), ORA)).toBe("resend");
    expect(resumeVerdict(row([watchdogCut, { kind: "text", text: "  \n" }]), ORA)).toBe("resend");
  });

  test("text or a tool after the cut: answered, no resend and no cap notice", () => {
    expect(resumeVerdict(row([watchdogCut, lateText]), ORA)).toBe("no");
    expect(resumeVerdict(row([watchdogCut, lateTool]), ORA)).toBe("no");
    expect(resumeVerdict(row([watchdogCut, lateText], MAX_RESUME_ATTEMPTS), ORA)).toBe("no");
    // A verdict recognised by its text, with no cause, reads the same way.
    expect(resumeVerdict(row([interruptedBlock, lateTool]), ORA)).toBe("no");
  });

  test("only the last verdict counts: cut again after the late answer, still resent", () => {
    expect(resumeVerdict(row([proseBlock, watchdogCut, lateText, watchdogCut]), ORA)).toBe("resend");
    expect(resumeVerdict(row([proseBlock, watchdogCut, lateText, watchdogCut], MAX_RESUME_ATTEMPTS), ORA)).toBe("capped");
  });
});

/**
 * The same two cases through the sweep, on a real database: what matters is
 * that the route is never called and nothing is written, not only the verdict.
 * And (c): on 3019832f there was no restart between 10:42 and 14:48, yet the
 * chat got six «il server si e' riavviato 4 volte» notices. The notice may  allow-italian: quotes the notice
 * speak of a restart only when the server really booted after the row.
 *
 * @covers RESUME-01, RESUME-02
 */
describe("the sweep on a queued send, a Stop, and a notice with no restart behind it", () => {
  const SK = "topic:x";
  const watchdogCut = {
    kind: "error",
    text: "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.",
    cause: "watchdog",
  } as ContentBlock;
  const HOUR = 60 * 60_000;

  function chatDb(rows: Array<{ id: string; role: string; agoMs: number; blocks?: ContentBlock[]; parent?: string }>, sk = SK): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
    )`);
    // The columns of migration 001 the sweep reads.
    db.run(`CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, session_key TEXT
    )`);
    rows.forEach((r, i) => db.run(
      "INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index) VALUES (?,?,?,?,?,0,?,?,?,0)",
      [r.id, sk, r.role, r.role === "user" ? "fai il merge" : "", r.blocks ? JSON.stringify(r.blocks) : null,
        new Date(Date.now() - r.agoMs).toISOString(), i, r.parent ?? null],
    ));
    return db;
  }
  const rowCount = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  /** A Stop as `activity_log` keeps it, `agoMs` before now. */
  const logStop = (db: Database, title: string, agoMs: number) => db.run(
    "INSERT INTO activity_log (id, timestamp, category, title, session_key) VALUES (?,?,'stream',?,?)",
    [crypto.randomUUID(), new Date(Date.now() - agoMs).toISOString(), title, SK],
  );
  const lastText = (db: Database) => (db.query(
    "SELECT content FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1",
  ).get(SK) as { content: string }).content;
  const blocksOfRow = (db: Database, id: string) =>
    JSON.parse(decodeCol((db.query("SELECT blocks FROM messages WHERE id = ?").get(id) as { blocks: unknown }).blocks) ?? "[]") as ContentBlock[];
  const ctxOf = (db: Database) => ({ db, getTopicBySessionKey: () => ({ archived: false }) });
  function countingRoute(calls: unknown[]): Parameters<typeof riprendiTurniInterrotti>[1] {
    return () => {
      calls.push(1);
      return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    };
  }
  const sweep = async (ctx: object, calls: unknown[]) => {
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
      await riprendiTurniInterrotti(ctx as Parameters<typeof riprendiTurniInterrotti>[0], countingRoute(calls), { responseMs: 500, streamMs: 500 });
    } finally { console.log = log; console.warn = warn; }
  };

  test("(a) the provider still holds a send for the chat: no call, no trace, no row", async () => {
    const cutChat = () => chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [proseBlock, watchdogCut], parent: "u0" },
    ]);
    // Control: the same chat with an idle provider IS resumed.
    const idleCalls: unknown[] = [];
    await sweep(ctxOf(cutChat()), idleCalls);
    expect(idleCalls).toHaveLength(1);

    for (const providerBusy of [() => true, async () => true]) {
      const db = cutChat();
      const before = rowCount(db);
      const calls: unknown[] = [];
      await sweep({ ...ctxOf(db), providerBusy }, calls);
      expect(calls).toHaveLength(0);
      expect(rowCount(db)).toBe(before);
      // The trace is written BEFORE a resend: none may be written here, or the
      // chain would count an attempt that never happened.
      expect(attemptsOnRow(blocksOfRow(db, "a0"))).toBe(0);
    }

    // A person's message with no answer and a queued send: it is on its way.
    const tail = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
    const calls: unknown[] = [];
    await sweep({ ...ctxOf(tail), providerBusy: () => true }, calls);
    expect(calls).toHaveLength(0);
    expect(rowCount(tail)).toBe(1);
  });

  test("(a) the late answer saved under the watchdog's verdict: no resend, nothing written", async () => {
    const db = chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [watchdogCut, { kind: "text", text: "merge fatto" }], parent: "u0" },
    ]);
    const calls: unknown[] = [];
    await sweep(ctxOf(db), calls);
    expect(calls).toHaveLength(0);
    expect(rowCount(db)).toBe(2);
  });

  test("(a) the queued-send line is said once per episode, not at every sweep", async () => {
    const sk = "topic:busy-log";
    const db = chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [proseBlock, watchdogCut], parent: "u0" },
    ], sk);
    const said: string[] = [];
    const sweepWith = async (busy: boolean) => {
      const log = console.log, warn = console.warn;
      console.log = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
      console.warn = () => {};
      try {
        await riprendiTurniInterrotti(
          { db, getTopicBySessionKey: () => ({ archived: false }), providerBusy: () => busy },
          countingRoute([]), { responseMs: 500, streamMs: 500 },
        );
      } finally { console.log = log; console.warn = warn; }
    };
    const queuedLines = () => said.filter((l) => l.includes(sk) && l.includes("ancora in coda")).length;
    await sweepWith(true);
    await sweepWith(true);
    expect(queuedLines()).toBe(1);
    // The queue drained and the sweep resent: the episode is over, the next one is news.
    await sweepWith(false);
    await sweepWith(true);
    expect(queuedLines()).toBe(2);
  });

  test("(a) on a chat that never goes idle, a new cut row is a new episode and is said", async () => {
    const sk = "topic:busy-rows";
    const db = chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [proseBlock, watchdogCut], parent: "u0" },
    ], sk);
    const said: string[] = [];
    const busySweep = async () => {
      const log = console.log, warn = console.warn;
      console.log = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
      console.warn = () => {};
      try {
        await riprendiTurniInterrotti(
          { db, getTopicBySessionKey: () => ({ archived: false }), providerBusy: () => true },
          countingRoute([]), { responseMs: 500, streamMs: 500 },
        );
      } finally { console.log = log; console.warn = warn; }
    };
    const queuedLines = () => said.filter((l) => l.includes(sk) && l.includes("ancora in coda")).length;
    await busySweep();
    await busySweep();
    expect(queuedLines()).toBe(1);
    // A second, unrelated stuck send: the person wrote again and that turn was cut too.
    const insert = (id: string, role: string, agoMs: number, parent: string, blocks: ContentBlock[] | null, order: number) => db.run(
      "INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index) VALUES (?,?,?,?,?,0,?,?,?,0)",
      [id, sk, role, role === "user" ? "fai il merge" : "", blocks ? JSON.stringify(blocks) : null,
        new Date(Date.now() - agoMs).toISOString(), order, parent],
    );
    insert("u1", "user", 4 * 60_000, "a0", null, 2);
    insert("a2", "assistant", 3 * 60_000, "u1", [proseBlock, watchdogCut], 3);
    await busySweep();
    expect(queuedLines()).toBe(2);
    await busySweep();
    expect(queuedLines()).toBe(2);
  });

  test("(b) the person pressed Stop: the route is never called and no notice is written", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
    recordTurnEnd(SK, cancelled("user", "POST /api/chat/abort"));
    const calls: unknown[] = [];
    await sweep(ctxOf(db), calls);
    expect(calls).toHaveLength(0);
    expect(rowCount(db)).toBe(1);
  });

  /**
   * The registry is memory, and this server reloads on every save in
   * `server/`: on the first boot after a Stop it is empty, and the stopped
   * message was resent as "unanswered", with a notice blaming the restart.
   * `activity_log` is what survives: the chat route's own abort line, and the
   * one the abort route writes before telling the provider.
   */
  test("(b) after a restart the registry is empty, and the Stop kept in activity_log still holds", async () => {
    for (const title of ["stream aborted by user", "stop pressed by user"]) {
      const db = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
      logStop(db, title, 225_000);
      const calls: unknown[] = [];
      await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - 60_000 }, calls);
      expect(calls, title).toHaveLength(0);
      expect(rowCount(db), title).toBe(1);
    }
  });

  test("(b) a Stop recorded before the message does not block its resend", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
    const calls: unknown[] = [];
    await sweep({
      ...ctxOf(db),
      lastTurnEnd: () => ({ info: cancelled("user"), atMs: Date.now() - 300_000 }),
    }, calls);
    expect(calls).toHaveLength(1);
    // Same for the durable trace: a Stop of the turn before, and one of another chat.
    const durable = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
    logStop(durable, "stop pressed by user", 300_000);
    durable.run(
      "INSERT INTO activity_log (id, timestamp, category, title, session_key) VALUES ('other', ?, 'stream', 'stop pressed by user', 'topic:other')",
      [new Date().toISOString()],
    );
    const durableCalls: unknown[] = [];
    await sweep(ctxOf(durable), durableCalls);
    expect(durableCalls).toHaveLength(1);
  });

  test("(b) a database without activity_log is no evidence, and the sweep still runs", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
    db.run("DROP TABLE activity_log");
    const calls: unknown[] = [];
    await sweep(ctxOf(db), calls);
    expect(calls).toHaveLength(1);
  });

  test("(c) unanswered with no boot since the message: no restart in the notice, and the resume still reads it as ours", async () => {
    for (const end of [null, cancelled("watchdog", "grace expired"), cancelled("wall-clock")]) {
      resetTurnEndRegistry();
      const db = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
      if (end) recordTurnEnd(SK, end);
      const calls: unknown[] = [];
      await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - HOUR }, calls);
      const label = end?.cause ?? "no end recorded";
      expect(calls, label).toHaveLength(1);
      // The notice is the row the resend is traced on, parented to the message.
      const notice = db.query("SELECT content, parent_id FROM messages WHERE role = 'assistant'").get() as { content: string; parent_id: string };
      expect(notice.parent_id, label).toBe("u0");
      expect(notice.content, label).not.toContain("riavviat");
      expect(notice.content.startsWith("⚠️"), label).toBe(true);
      expect(eCartelloDiInterruzione(notice.content), label).toBe(true);
      if (end?.cause === "watchdog") expect(notice.content).toContain("non dava più segni di vita");
    }
  });

  test("(c) unanswered after a real boot, cause unknown: the restart notice, word for word", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
    await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - 60_000 }, []);
    const notice = db.query("SELECT content FROM messages WHERE role = 'assistant'").get() as { content: string };
    expect(notice.content).toBe(UNANSWERED_NOTICE);
  });

  test("(c) a turn that ended after the boot: the restart is not what left the message unanswered", async () => {
    // Not `end_turn`: a normal end answers the message (see (d)). The first
    // end names no cause (an `abort()` with no reason), so only the end's time
    // against the boot can keep the restart out of the notice; the second
    // names a cause that is not a restart.
    const ends: TurnEndInfo[] = [{ end: "cancelled" }, { end: "error", cause: "process-died" }];
    for (const end of ends) {
      resetTurnEndRegistry();
      const label = `${end.end}/${end.cause ?? "-"}`;
      const db = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
      // Recorded now, after the boot of four minutes ago: the answer started
      // after the restart, so blaming the restart would be false.
      recordTurnEnd(SK, end);
      const calls: unknown[] = [];
      await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - 4 * 60_000 }, calls);
      expect(calls, label).toHaveLength(1);
      const notice = db.query("SELECT content FROM messages WHERE role = 'assistant'").get() as { content: string };
      expect(notice.content, label).not.toContain("riavvi");
      expect(eCartelloDiInterruzione(notice.content), label).toBe(true);
    }
  });

  test("(d) a manual /compact that ended normally: no resend and no notice", async () => {
    // The compaction's empty answer row was discarded, so '/compact' is the
    // last row, and the turn end the route recorded after it is `end_turn`.
    const db = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
    db.run("UPDATE messages SET content = '/compact' WHERE id = 'u0'");
    recordTurnEnd(SK, { end: "end_turn" });
    const calls: unknown[] = [];
    await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - HOUR }, calls);
    expect(calls).toHaveLength(0);
    expect(rowCount(db)).toBe(1);
  });

  test("(c) unanswered after a boot but cut by the watchdog: the cause wins over the boot", async () => {
    // A claude-code turn reattached after the boot keeps its pre-boot message,
    // and the watchdog cut it later: the restart is not what left it unanswered.
    const db = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
    recordTurnEnd(SK, cancelled("watchdog", "grace expired"));
    await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - 4 * 60_000 }, []);
    const notice = db.query("SELECT content FROM messages WHERE role = 'assistant'").get() as { content: string };
    expect(notice.content).toContain("non dava più segni di vita");
    expect(notice.content).not.toContain("riavviat");
    expect(eCartelloDiInterruzione(notice.content)).toBe(true);
  });

  const capped = (cut: ContentBlock, agoMs = 9 * 60_000) => () => chatDb([
    { id: "u0", role: "user", agoMs: 10 * 60_000 },
    { id: "a0", role: "assistant", agoMs, blocks: [{ kind: "ripreso", attempt: MAX_RESUME_ATTEMPTS } as ContentBlock, proseBlock, cut], parent: "u0" },
  ]);
  const cappedTail = () => chatDb([
    { id: "u0", role: "user", agoMs: 10 * 60_000 },
    { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [{ kind: "ripreso", attempt: MAX_RESUME_ATTEMPTS } as ContentBlock, proseBlock, watchdogCut], parent: "u0" },
    { id: "u1", role: "user", agoMs: 5 * 60_000, parent: "a0" },
  ]);
  const EARLY_BOOT = () => Date.now() - HOUR;
  const LATE_BOOT = () => Date.now();

  /**
   * Chains that spent their attempts, and the wording each must get. CAUSE
   * FIRST: an answer row is judged by its cut, never by its timestamp. A
   * watchdog cut followed by a reload on save predates the boot, and the boot
   * sweep writes a hard kill's notice with no cause AFTER the boot. Only a
   * person's message, which has no cut row, falls back on the boot time.
   */
  const cappedCases: Array<[string, () => Database, () => number, "restart" | "stall" | "generic"]> = [
    ["watchdog cut, no boot since", capped(watchdogCut), EARLY_BOOT, "stall"],
    ["watchdog cut, a reload after it", capped(watchdogCut), LATE_BOOT, "stall"],
    ["hard kill: the boot sweep's notice, newer than the boot",
      capped({ kind: "error", text: RESTART_INTERRUPTED_MARKER } as ContentBlock, 60_000), EARLY_BOOT, "restart"],
    ["graceful shutdown: the notice without a cause", capped(interruptedBlock), EARLY_BOOT, "restart"],
    ["graceful shutdown: cause server-shutdown",
      capped({ kind: "error", text: "Turno interrotto.", cause: "server-shutdown" } as ContentBlock), EARLY_BOOT, "restart"],
    ["a cut of ours that is no restart",
      capped({ kind: "error", text: "Risposta interrotta: nessuna attività per 3 minuti." } as ContentBlock), LATE_BOOT, "generic"],
    ["person's message at the end of the chain, no boot since", cappedTail, EARLY_BOOT, "generic"],
    ["person's message at the end of the chain, booted after it", cappedTail, LATE_BOOT, "restart"],
  ];

  test("(c) capped: the notice names what cut the chain, and stays unrecognised", async () => {
    for (const [label, make, bootedAt, wording] of cappedCases) {
      const db = make();
      const before = rowCount(db);
      const calls: unknown[] = [];
      await sweep({ ...ctxOf(db), bootedAtMs: bootedAt() }, calls);
      expect(calls, label).toHaveLength(0);
      expect(rowCount(db), label).toBe(before + 1);
      const text = lastText(db);
      expect(text.startsWith("⚠️ Ripresa automatica sospesa:"), label).toBe(true);
      expect(text, label).toContain("Riprova");
      // Recognised as an interruption, the next sweep would resume the chain it closes.
      expect(eCartelloDiInterruzione(text), label).toBe(false);
      if (wording === "restart") expect(text, label).toBe(RESUME_CAP_MARKER);
      else expect(text, label).not.toContain("riavvi");
      expect(text.includes("ha smesso di rispondere"), label).toBe(wording === "stall");
    }
  });
});

/**
 * The durable Stop, end to end on the real schema: the helper the abort route
 * calls, and the chat route's own abort line, read back by the sweep from the
 * table migration 001 creates. The in-memory table above cannot tell whether
 * its columns are the real ones; this can.
 *
 * @covers RESUME-01
 */
describe("the Stop the server writes is the Stop the sweep reads", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "resume-stop-"));
    initDatabase(tmpRoot);
  });
  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* scratch dir */ }
  });

  const writers: Array<[string, (sk: string) => void]> = [
    ["the abort route", (sk) => activityLog.logStopPressed({ sessionKey: sk, topicId: "t1" })],
    ["the chat route", (sk) => logStreamAborted({ sessionKey: sk, topicId: "t1", title: abortLogTitle(cancelled("user")) })],
  ];

  test("a message stopped before the restart is not resent after it", async () => {
    for (const [label, writeStop] of writers) {
      const sk = `topic:stop-${label.replace(/\W/g, "")}`;
      const db = getDatabase();
      db.run(
        "INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?,?,'user','fai il merge',?,0)",
        [`u-${sk}`, sk, new Date(Date.now() - 230_000).toISOString()],
      );
      writeStop(sk);
      const calls: unknown[] = [];
      const log = console.log, warn = console.warn;
      console.log = () => {}; console.warn = () => {};
      try {
        await riprendiTurniInterrotti(
          { db, getTopicBySessionKey: () => ({ archived: false }), bootedAtMs: Date.now() - 60_000 },
          () => { calls.push(1); return new Response(null, { status: 200 }); },
          { responseMs: 500, streamMs: 500 },
        );
      } finally { console.log = log; console.warn = warn; }
      expect(calls, label).toHaveLength(0);
    }
  });
});

/**
 * Every wording the two builders can produce, against the recogniser. The
 * unanswered notice becomes the row the resend is traced on, so the next sweep
 * must read it as ours; the cap notice closes a chain, so it must not.
 *
 * @covers RESUME-01, RESUME-02
 */
describe("the notice variants and the recogniser", () => {
  const ends = [
    null,
    cancelled("watchdog"),
    cancelled("wall-clock"),
    cancelled("server-shutdown"),
    cancelled("user"),
    { end: "error", cause: "rate-limit" } as const,
    { end: "end_turn" } as const,
  ];

  /** Cause first: a named cause decides, and only `server-shutdown` is a
   *  restart; `restarted` speaks only when no cause is known. */
  const blamesRestart = (cause: unknown, restarted: boolean) =>
    typeof cause === "string" ? cause === "server-shutdown" : restarted;

  test("every unanswered notice is recognised, and a restart is blamed only when it is the cause", () => {
    for (const lastEnd of ends) {
      for (const restarted of [true, false]) {
        const text = boot.unansweredNotice({ restarted, lastEnd });
        const cause = (lastEnd as { cause?: string } | null)?.cause;
        const label = `${lastEnd?.end ?? "none"}/${cause ?? "-"} restarted=${restarted}`;
        expect(eCartelloDiInterruzione(text), label).toBe(true);
        expect(text.startsWith("⚠️"), label).toBe(true);
        expect(text.includes("riavvi"), label).toBe(blamesRestart(cause, restarted));
      }
    }
    const stalled = boot.unansweredNotice({ restarted: true, lastEnd: cancelled("watchdog") });
    expect(stalled).toContain("non dava più segni di vita");
    expect(boot.unansweredNotice({ restarted: false, lastEnd: cancelled("server-shutdown") })).toBe(UNANSWERED_NOTICE);
  });

  test("every cap notice keeps the retry and stays unrecognised, and a restart is blamed only when it is the cause", () => {
    for (const cause of [undefined, "watchdog", "wall-clock", "server-shutdown", "rate-limit", "tool-budget"]) {
      for (const restarted of [true, false]) {
        const text = boot.resumeCapNotice({ restarted, cause });
        const label = `${cause ?? "none"} restarted=${restarted}`;
        expect(text.startsWith("⚠️ Ripresa automatica sospesa:"), label).toBe(true);
        expect(text, label).toContain("Riprova");
        expect(eCartelloDiInterruzione(text), label).toBe(false);
        expect(text.includes("riavvi"), label).toBe(blamesRestart(cause, restarted));
      }
    }
    expect(boot.resumeCapNotice({ restarted: true, cause: "watchdog" })).not.toBe(RESUME_CAP_MARKER);
    expect(boot.resumeCapNotice({ restarted: false, cause: "server-shutdown" })).toBe(RESUME_CAP_MARKER);
  });

  /**
   * What a notice may claim. The count is of RESENDS, the only thing counted;
   * the cause belongs to the LAST cut, the only one read. «l'agente ha smesso
   * di rispondere 4 volte di fila» extended one watchdog to the whole chain,  allow-italian: quotes the notice
   * and the restart variant counted four restarts after a single boot. One
   * voice (the server speaking, first person) and one spelling (the accented
   * vowel, never the apostrophe that stood in for it).
   */
  test("every variant counts resends, blames only the last cut, and speaks one way", () => {
    const caps = [undefined, "watchdog", "server-shutdown", "rate-limit"].flatMap((cause) =>
      [true, false].map((restarted) => boot.resumeCapNotice({ restarted, cause })));
    const unanswered = [null, cancelled("watchdog"), cancelled("wall-clock"), cancelled("server-shutdown"), { end: "end_turn" } as const]
      .flatMap((lastEnd) => [true, false].map((restarted) => boot.unansweredNotice({ restarted, lastEnd })));
    for (const text of caps) {
      expect(text).toContain(`${MAX_RESUME_ATTEMPTS} volte`);
      expect(text).not.toContain("di fila");
      if (text.includes("riavvi") || text.includes("smesso di rispondere")) expect(text).toContain("l'ultima volta");
    }
    for (const text of [...caps, ...unanswered]) {
      expect(text).not.toMatch(/e' /);
      expect(text).not.toContain("l'aveva");
    }
    // Every unanswered variant says what happens next, the restart one included.
    for (const text of unanswered) expect(text.endsWith("Lo rimando."), text).toBe(true);
  });
});
