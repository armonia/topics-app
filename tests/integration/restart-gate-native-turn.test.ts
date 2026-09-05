/**
 * THE RESTART GATE OVER A FAKE NATIVE TURN.
 *
 * The unit tests of `server/lib/quiescence.ts` prove the rules one at a time.
 * Here the whole chain runs the way `waitForDispatcherQuiescent` uses it: the
 * stream register, the row on disk that says whether the turn is over, the
 * verdict, the heartbeat file that holds off the SIGTERM of `start-prod.sh`,
 * the notice. The measured defects were never a wrong rule: they were in WHAT
 * the loop did with the right one.
 *
 * Two measures this file pins down:
 *   · 2026-09-04 00:12, a native turn on topic:a4d19786 holds
 *     `restart-when-idle`. The deferral is a fact from the first instant, but
 *     it was declared only past the long cap: until then no heartbeat (so the
 *     script was free to SIGTERM the very turn the gate was protecting) and no
 *     notice to the one person who could end the wait.
 *   · 2026-09-03, 2160 seconds of waiting on topic:6b9605e5, whose turn had
 *     already died of a `400 prompt is too long`: the entry had stayed in the
 *     in-memory register, and the gate counted the entry instead of the turn.
 *
 * The database is real (bun:sqlite) and the heartbeat file is real; the clock
 * is not. A cap is proven by making it expire, not by waiting a minute.
 *
 * @covers RGATE-01, RGATE-02, RGATE-03
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "./helpers";
import {
  describeInFlight,
  quiescenceVerdict,
  reloadHeldNotice,
  unadoptableStreams,
  unfinishedStreams,
  type ReloadHeldNotice,
} from "../../server/lib/quiescence";
import { touchReloadDeferred, RELOAD_DEFERRED_FILE } from "../../server/lib/reload-deferred";

const TEST_HOME = testTmpDir("restart-gate");

beforeAll(() => {
  process.env.TOPICS_HOME = TEST_HOME;
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const CHAT_CAP_MS = 60_000;
const CAP_MS = 25 * 60_000;

interface FakeStream {
  sessionKey: string;
  messageId: string;
  survivesRestart: boolean;
}

/** An assistant row as a turn writes it: `partial` is the pivot. */
function makeDb(rows: Array<{ id: string; partial: number }>): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, partial INTEGER)");
  const insert = db.prepare("INSERT INTO messages (id, partial) VALUES (?, ?)");
  for (const r of rows) insert.run(r.id, r.partial);
  return db;
}

/**
 * The exact shape of the `waitForDispatcherQuiescent` loop, with the clock in
 * the test's hands. Returns what happened: when the first heartbeat was
 * written, when (and how often) the notice fired, and how the wait ended.
 */
function runGate(opts: {
  db: Database;
  streams: FakeStream[];
  cards?: number;
  /** How many milliseconds the run lasts, in 500 ms loops as in production. */
  forMs: number;
  /** The turn ends by itself at this instant (its row gets finalized). */
  finishAt?: number;
}) {
  const { db, streams } = opts;
  const cards = opts.cards ?? 0;
  const statement = db.prepare("SELECT partial FROM messages WHERE id = ?");
  const turnFinished = (messageId: string): boolean => {
    const row = statement.get(messageId) as { partial?: number } | undefined;
    return row ? row.partial === 0 : false;
  };

  const heartbeatFile = join(TEST_HOME, RELOAD_DEFERRED_FILE);
  fs.rmSync(heartbeatFile, { force: true });

  let firstHeartbeatAt: number | null = null;
  let notice: { at: number; value: ReloadHeldNotice } | null = null;
  let notices = 0;
  let outcome: "procedi" | "tagliato" | "ancora in attesa" = "ancora in attesa";
  let notified = false;

  for (let now = 0; now <= opts.forMs; now += 500) {
    if (opts.finishAt !== undefined && now >= opts.finishAt) {
      db.run("UPDATE messages SET partial = 0");
    }
    const live = unfinishedStreams(streams, turnFinished);
    const streamKeys = live.map((s) => s.sessionKey);
    const unadoptable = unadoptableStreams(live).length;
    const busy = describeInFlight({ cards, streamKeys, brokerOpenKeys: [] });
    const verdict = quiescenceVerdict({
      busy, unrecoverable: cards + unadoptable,
      now, startedAt: 0, chatCapMs: CHAT_CAP_MS,
    });
    if (verdict === "procedi") { outcome = "procedi"; break; }
    if (verdict === "scaduto") { outcome = "tagliato"; break; }
    if (verdict === "rinvia") {
      // The real heartbeat: the file `start-prod.sh` reads so it does not fire
      // its own SIGTERM in our place.
      touchReloadDeferred();
      if (firstHeartbeatAt === null && fs.existsSync(heartbeatFile)) firstHeartbeatAt = now;
      const noticeAfterMs = cards > 0 ? CAP_MS : CHAT_CAP_MS;
      if (!notified && now >= noticeAfterMs) {
        const held = reloadHeldNotice({
          waitedMs: now, noticeAfterMs, busy: busy ?? "",
          holderName: null, holderKind: "turn", waitId: "w-test",
        });
        if (held) {
          notified = true;
          notices += 1;
          notice = { at: now, value: held };
        }
      }
    }
  }
  return { firstHeartbeatAt, notice, notices, outcome };
}

describe("restart-when-idle sopra un turno nativo (RGATE-01, RGATE-02)", () => {
  const nativeTurn: FakeStream = { sessionKey: "topic:a4d19786", messageId: "m-nativeTurn", survivesRestart: false };

  test("il rinvio e' dichiarato al PRIMO giro, non dopo il tetto lungo", () => {
    const out = runGate({ db: makeDb([{ id: "m-nativeTurn", partial: 1 }]), streams: [nativeTurn], forMs: 5_000 });
    expect(out.firstHeartbeatAt).toBe(0);
    expect(out.outcome).toBe("ancora in attesa");
  });

  test("la notifica arriva al minuto, una sola volta, e nomina il topic", () => {
    const out = runGate({ db: makeDb([{ id: "m-nativeTurn", partial: 1 }]), streams: [nativeTurn], forMs: 5 * 60_000 });
    expect(out.notice?.at).toBe(CHAT_CAP_MS);
    expect(out.notices).toBe(1);
    expect(out.notice?.value.body).toContain("topic:a4d19786");
    expect(out.notice?.value.body).toContain("fermalo dalla chat");
  });

  test("e il turno non viene MAI tagliato, per quanto si aspetti", () => {
    const out = runGate({ db: makeDb([{ id: "m-nativeTurn", partial: 1 }]), streams: [nativeTurn], forMs: 60 * 60_000 });
    expect(out.outcome).not.toBe("tagliato");
  });

  /**
   * The other half, or this would be a block instead of a deferral: the moment
   * the turn ends, the restart goes by itself.
   */
  test("finito il turno, il riavvio parte da solo", () => {
    const out = runGate({
      db: makeDb([{ id: "m-nativeTurn", partial: 1 }]), streams: [nativeTurn],
      forMs: 10 * 60_000, finishAt: 2 * 60_000,
    });
    expect(out.outcome).toBe("procedi");
  });

  /**
   * A CARD holds the same way, but at the minute it wakes nobody: its turn has
   * a bound of its own (`dispatchTimeoutMin`), so that wait ends by itself.
   */
  test("una card rinvia subito ma avvisa tardi", () => {
    const out = runGate({ db: makeDb([]), streams: [], cards: 1, forMs: 5 * 60_000 });
    expect(out.firstHeartbeatAt).toBe(0);
    expect(out.notice).toBeNull();
  });
});

describe("un turno morto non trattiene niente (RGATE-03)", () => {
  test("lo stream di un turno gia' finalizzato non conta come in streaming", () => {
    // topic:6b9605e5, dead of "prompt is too long": the row is finalized, the
    // entry in the register stayed behind.
    const out = runGate({
      db: makeDb([{ id: "m-morto", partial: 0 }]),
      streams: [{ sessionKey: "topic:6b9605e5", messageId: "m-morto", survivesRestart: false }],
      forMs: 5_000,
    });
    expect(out.outcome).toBe("procedi");
    expect(out.firstHeartbeatAt).toBeNull();
  });

  test("il morto non copre il vivo: se resta un turno aperto, si rinvia lo stesso", () => {
    const out = runGate({
      db: makeDb([{ id: "m-morto", partial: 0 }, { id: "m-vivo", partial: 1 }]),
      streams: [
        { sessionKey: "topic:6b9605e5", messageId: "m-morto", survivesRestart: false },
        { sessionKey: "topic:a4d19786", messageId: "m-vivo", survivesRestart: false },
      ],
      forMs: 2 * 60_000,
    });
    expect(out.outcome).toBe("ancora in attesa");
    expect(out.notice?.value.body).toContain("topic:a4d19786");
    expect(out.notice?.value.body).not.toContain("topic:6b9605e5");
  });
});
