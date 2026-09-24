/**
 * The resume sweep against a send still queued on the provider, a message the
 * person stopped, and notices that blamed a restart nobody had. Split from
 * `ripresa-boot.test.ts`, which holds the rest of the rule.
 *
 * @covers RESUME-01, RESUME-02
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_RESUME_ATTEMPTS, RESUME_CAP_MARKER, UNANSWERED_NOTICE, attemptsOnRow, riprendiTurniInterrotti,
  resumeVerdict,
} from "./ripresa-boot";
// The notice builders are new: reached through the namespace so this file still
// loads on the code before the fix, where the verdict tests must fail on the
// verdict and not on a missing import.
import * as boot from "./ripresa-boot";
import { eCartelloDiInterruzione } from "./cancelled-notice";
import { decodeCol } from "../../shared/message-blob";
import { recordTurnEnd, resetTurnEndRegistry } from "../providers/turn-end-registry";
import { cancelled } from "../providers/stop-reason";
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

  function chatDb(rows: Array<{ id: string; role: string; agoMs: number; blocks?: ContentBlock[]; parent?: string }>): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
    )`);
    rows.forEach((r, i) => db.run(
      "INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index) VALUES (?,?,?,?,?,0,?,?,?,0)",
      [r.id, SK, r.role, r.role === "user" ? "fai il merge" : "", r.blocks ? JSON.stringify(r.blocks) : null,
        new Date(Date.now() - r.agoMs).toISOString(), i, r.parent ?? null],
    ));
    return db;
  }
  const rowCount = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
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

  test("(b) the person pressed Stop: the route is never called and no notice is written", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
    recordTurnEnd(SK, cancelled("user", "POST /api/chat/abort"));
    const calls: unknown[] = [];
    await sweep(ctxOf(db), calls);
    expect(calls).toHaveLength(0);
    expect(rowCount(db)).toBe(1);
  });

  test("(b) a Stop recorded before the message does not block its resend", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 230_000 }]);
    const calls: unknown[] = [];
    await sweep({
      ...ctxOf(db),
      lastTurnEnd: () => ({ info: cancelled("user"), atMs: Date.now() - 300_000 }),
    }, calls);
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

  test("(c) unanswered after a real boot: the restart notice, word for word", async () => {
    const db = chatDb([{ id: "u0", role: "user", agoMs: 5 * 60_000 }]);
    await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - 60_000 }, []);
    const notice = db.query("SELECT content FROM messages WHERE role = 'assistant'").get() as { content: string };
    expect(notice.content).toBe(UNANSWERED_NOTICE);
  });

  /** Three chains that spent their attempts: a watchdog cut, a boot notice
   *  with no cause on it, and a person's message at the end of the chain. */
  const cappedChats = (): Array<[string, () => Database]> => [
    ["watchdog cut", () => chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [{ kind: "ripreso", attempt: MAX_RESUME_ATTEMPTS } as ContentBlock, proseBlock, watchdogCut], parent: "u0" },
    ])],
    ["notice without a cause", () => chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [interruptedBlock, { kind: "ripreso", attempt: MAX_RESUME_ATTEMPTS } as ContentBlock], parent: "u0" },
    ])],
    ["person's message at the end of the chain", () => chatDb([
      { id: "u0", role: "user", agoMs: 10 * 60_000 },
      { id: "a0", role: "assistant", agoMs: 9 * 60_000, blocks: [{ kind: "ripreso", attempt: MAX_RESUME_ATTEMPTS } as ContentBlock, proseBlock, watchdogCut], parent: "u0" },
      { id: "u1", role: "user", agoMs: 5 * 60_000, parent: "a0" },
    ])],
  ];

  test("(c) capped with no boot since the row: no restart in the notice, and it stays unrecognised", async () => {
    for (const [label, make] of cappedChats()) {
      const db = make();
      const before = rowCount(db);
      const calls: unknown[] = [];
      await sweep({ ...ctxOf(db), bootedAtMs: Date.now() - HOUR }, calls);
      expect(calls, label).toHaveLength(0);
      expect(rowCount(db), label).toBe(before + 1);
      const text = lastText(db);
      expect(text.startsWith("⚠️ Ripresa automatica sospesa:"), label).toBe(true);
      expect(text, label).not.toContain("riavviat");
      expect(text, label).toContain("Riprova");
      // Recognised as an interruption, the next sweep would resume the chain it closes.
      expect(eCartelloDiInterruzione(text), label).toBe(false);
    }
  });

  test("(c) capped after a real boot: the restart cap notice, word for word", async () => {
    for (const [label, make] of cappedChats()) {
      const db = make();
      await sweep({ ...ctxOf(db), bootedAtMs: Date.now() }, []);
      expect(lastText(db), label).toBe(RESUME_CAP_MARKER);
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

  test("every unanswered notice is recognised, and only a real restart is blamed", () => {
    for (const lastEnd of ends) {
      for (const restarted of [true, false]) {
        const text = boot.unansweredNotice({ restarted, lastEnd });
        const label = `${lastEnd?.end ?? "none"}/${(lastEnd as { cause?: string } | null)?.cause ?? "-"} restarted=${restarted}`;
        expect(eCartelloDiInterruzione(text), label).toBe(true);
        expect(text.startsWith("⚠️"), label).toBe(true);
        expect(text.includes("riavviat"), label).toBe(restarted);
      }
    }
    expect(boot.unansweredNotice({ restarted: true, lastEnd: cancelled("watchdog") })).toBe(UNANSWERED_NOTICE);
  });

  test("every cap notice keeps the retry and stays unrecognised, and only a real restart is blamed", () => {
    for (const cause of [undefined, "watchdog", "wall-clock", "server-shutdown", "rate-limit", "tool-budget"]) {
      for (const restarted of [true, false]) {
        const text = boot.resumeCapNotice({ restarted, cause });
        const label = `${cause ?? "none"} restarted=${restarted}`;
        expect(text.startsWith("⚠️ Ripresa automatica sospesa:"), label).toBe(true);
        expect(text, label).toContain("Riprova");
        expect(eCartelloDiInterruzione(text), label).toBe(false);
        expect(text.includes("riavviat"), label).toBe(restarted);
      }
    }
    expect(boot.resumeCapNotice({ restarted: true, cause: "watchdog" })).toBe(RESUME_CAP_MARKER);
  });
});
