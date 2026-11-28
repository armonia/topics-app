/**
 * @covers MAIL-01 MAIL-02
 * Incoming mail: no hole, no double, through restarts (the mail inbox change, track E1).
 * Scripted adapter, fake clock, a real SQLite file with the real migrations.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createOwnerAlert } from "../../schedule/deliver/owner-alert";
import { createDeliveryRegistry } from "../../schedule/deliver/registry";
import { parseDeliverySettings } from "../../schedule/deliver/settings";
import type { AdapterCall, AdapterResult } from "../../schedule/deliver/adapter";
import { commandListAdapter } from "./contract";
import { CADENCE_MS, createInbox, FAST_CADENCE_MS, type InboxAlert, type InboxOptions } from "./inbox";
import { mergeMailboxes, parseMailboxes } from "./mailboxes";
import { clock, createTestDb, mailbox, message, scriptedAdapter, type TestDb } from "./inbox-test-support";
import { commitRound, readState } from "./store";

let testDb: TestDb;
let db: Database;
let time: ReturnType<typeof clock>;
let alerts: InboxAlert[];

beforeEach(() => {
  testDb = createTestDb();
  db = testDb.open();
  time = clock();
  alerts = [];
});
afterEach(() => testDb.dispose());

const T1 = "2026-11-28T09:00:00.000Z";
const T2 = "2026-11-28T09:10:00.000Z";
const T3 = "2026-11-28T09:20:00.000Z";
const rows = (connection: Database = db) => connection.query("SELECT provider_id, own FROM mail_messages ORDER BY provider_id").all() as Array<{ provider_id: string; own: number }>;

function build(extra: Partial<InboxOptions> & { adapter: ReturnType<typeof scriptedAdapter>["adapter"] }, connection: Database = db, boxes = [mailbox()]) {
  const { adapter, ...rest } = extra;
  return createInbox({ db: connection, now: time.now, mailboxes: () => boxes, adapterFor: () => adapter, alert: (alert) => alerts.push(alert), owner: "server-a", ...rest });
}

describe("one row per message, through restarts", () => {
  test("the same message twice is one row", async () => {
    const script = scriptedAdapter([message("a", T1)]);
    const inbox = build({ adapter: script.adapter });
    await inbox.tick();
    time.advance(CADENCE_MS);
    // A provider that repeats the message (overlap): the cursor is forgotten on purpose.
    db.prepare("UPDATE mail_inbox_state SET cursor = NULL").run();
    await inbox.tick();
    expect(rows()).toEqual([{ provider_id: "a", own: 0 }]);
  });

  test("a stop halfway through the transaction writes nothing and holds the cursor; the next round has no hole and no double", async () => {
    const script = scriptedAdapter([message("a", T1), message("b", T2)]);
    let crash = true;
    const inbox = build({ adapter: script.adapter, onStored: () => { if (crash) throw new Error("killed inside the transaction"); } });
    expect(await inbox.readMailbox(mailbox())).toBe("failed");
    expect(rows()).toEqual([]);
    expect(readState(db, "box").cursor).toBeNull();
    crash = false;
    time.advance(CADENCE_MS);
    expect(await inbox.readMailbox(mailbox())).toBe("read");
    expect(rows().map((row) => row.provider_id)).toEqual(["a", "b"]);
    expect(readState(db, "box").cursor).toBe(String(Date.parse(T2)));
  });

  test("a stop after the messages and before the cursor is saved leaves neither", async () => {
    const script = scriptedAdapter([message("a", T1), message("b", T2)]);
    const inbox = build({ adapter: script.adapter });
    // The stop is a trigger that aborts the cursor write: the last statement of the round.
    db.exec("CREATE TRIGGER stop_at_cursor BEFORE UPDATE OF cursor ON mail_inbox_state WHEN NEW.cursor IS NOT NULL BEGIN SELECT RAISE(ABORT, 'killed before the cursor'); END;");
    db.prepare("INSERT INTO mail_inbox_state (mailbox) VALUES ('box')").run();
    expect(await inbox.readMailbox(mailbox())).toBe("failed");
    expect(rows()).toEqual([]);
    expect(readState(db, "box").cursor).toBeNull();
    db.exec("DROP TRIGGER stop_at_cursor");
    time.advance(CADENCE_MS);
    expect(await inbox.readMailbox(mailbox())).toBe("read");
    expect(rows().map((row) => row.provider_id)).toEqual(["a", "b"]);
  });

  test("a cursor the provider forgot rereads the window, never from now", async () => {
    const script = scriptedAdapter([message("a", T1), message("b", T2), message("c", T3)]);
    script.state.expireCursors = true;
    const inbox = build({ adapter: script.adapter });
    db.prepare("INSERT INTO mail_inbox_state (mailbox, cursor) VALUES ('box', ?)").run(String(Date.parse(T1)));
    await inbox.tick();
    const [first, second] = script.requests;
    expect(first?.cursor).not.toBeNull();
    expect(second?.cursor).toBeNull();
    expect(second?.sinceMs).toBe(time.now().getTime() - 72 * 3_600_000);
    expect(rows().map((row) => row.provider_id)).toEqual(["a", "b", "c"]);
  });

  test("a message from one of the mailbox's own addresses is marked own", async () => {
    const script = scriptedAdapter([message("mine", T1, { from: "Me@Example.test" }), message("theirs", T2)]);
    await build({ adapter: script.adapter }).tick();
    expect(rows()).toEqual([{ provider_id: "mine", own: 1 }, { provider_id: "theirs", own: 0 }]);
  });
});

describe("a broken adapter is an error of the round", () => {
  const run = (result: AdapterResult | Error) => async (_call: AdapterCall) => { if (result instanceof Error) throw result; return result; };
  const outcome = (stdout: string, extra: Partial<AdapterResult> = {}): AdapterResult => ({ exitCode: 0, stdout, stderr: "", ...extra });

  test.each([
    ["exits non-zero", outcome("", { exitCode: 3 })],
    ["answers invalid JSON", outcome("not json")],
    ["answers a message with no sender", outcome(JSON.stringify({ messages: [{ id: "x", from: "", receivedAt: T1 }], cursor: "1" }))],
    ["goes over 30 seconds", outcome("{}", { timedOut: true })],
  ])("the adapter %s: error on the round, cursor held, nothing written", async (_label, result) => {
    db.prepare("INSERT INTO mail_inbox_state (mailbox, cursor) VALUES ('box', 'keep')").run();
    const inbox = createInbox({ db, now: time.now, mailboxes: () => [mailbox()], adapterFor: (box) => commandListAdapter(box, run(result)), alert: () => {} });
    expect(await inbox.readMailbox(mailbox())).toBe("failed");
    const state = readState(db, "box");
    expect(state.cursor).toBe("keep");
    expect(state.failures).toBe(1);
    expect(rows()).toEqual([]);
  });

  test("the request goes on stdin as JSON and the mailbox name is in the environment", async () => {
    const seen: AdapterCall[] = [];
    const inbox = createInbox({
      db, now: time.now, mailboxes: () => [mailbox()], alert: () => {},
      adapterFor: (box) => commandListAdapter(box, async (call) => { seen.push(call); return outcome(JSON.stringify({ messages: [], cursor: null })); }),
    });
    await inbox.tick();
    expect(JSON.parse(seen[0]!.stdin)).toMatchObject({ op: "list", cursor: null, limit: 100 });
    expect(seen[0]!.env.TOPICS_MAILBOX).toBe("box");
  });
});

describe("what is read, and what is not", () => {
  test("no mailbox declared: no adapter is built, no process starts", async () => {
    let built = 0;
    const inbox = createInbox({ db, now: time.now, mailboxes: () => [], adapterFor: () => { built++; return scriptedAdapter([]).adapter; }, alert: () => {} });
    expect(await inbox.tick()).toEqual({});
    expect(built).toBe(0);
  });

  test("a mailbox with both switches off is not read", async () => {
    const script = scriptedAdapter([message("a", T1)]);
    const inbox = build({ adapter: script.adapter }, db, [mailbox({ agentsMayWait: false, rulesEnabled: false })]);
    expect(await inbox.tick()).toEqual({ box: "skipped" });
    expect(script.requests).toHaveLength(0);
  });

  test("the setting and the environment both name a mailbox: the setting wins, the environment copy has no adapter", () => {
    const declared = parseMailboxes(JSON.stringify([{ name: "work", addresses: ["a@example.test"], adapter: { argv: ["/bin/x"] }, agentsMayWait: true }]));
    const merged = mergeMailboxes(declared, [
      { name: "work", address: "env@example.test", transport: "default", cli: "/bin/send" },
      { name: "other", address: "o@example.test", transport: "default", cli: "/bin/send" },
    ]);
    expect(merged.map((box) => [box.name, box.addresses[0], box.fromEnv])).toEqual([["work", "a@example.test", false], ["other", "o@example.test", true]]);
    expect(merged[1]!.adapter).toBeNull();
  });

  test("a broken setting text is no mailbox, not a crash", () => {
    expect(parseMailboxes("{nope")).toEqual([]);
    expect(parseMailboxes(null)).toEqual([]);
  });
});

describe("cadence", () => {
  test("60 s by default", async () => {
    const script = scriptedAdapter([]);
    const inbox = build({ adapter: script.adapter });
    await inbox.tick();
    time.advance(CADENCE_MS - 1);
    await inbox.tick();
    expect(script.requests).toHaveLength(1);
    time.advance(1);
    await inbox.tick();
    expect(script.requests).toHaveLength(2);
  });

  test("15 s with a wait that expires within 30 minutes", async () => {
    const script = scriptedAdapter([]);
    const inbox = build({ adapter: script.adapter, nextWaitExpiry: () => new Date(time.now().getTime() + 29 * 60_000) });
    await inbox.tick();
    time.advance(FAST_CADENCE_MS - 1);
    await inbox.tick();
    expect(script.requests).toHaveLength(1);
    time.advance(1);
    await inbox.tick();
    expect(script.requests).toHaveLength(2);
  });

  test("a wait that expires in 31 minutes does not speed it up", async () => {
    const script = scriptedAdapter([]);
    const inbox = build({ adapter: script.adapter, nextWaitExpiry: () => new Date(time.now().getTime() + 31 * 60_000) });
    await inbox.tick();
    time.advance(FAST_CADENCE_MS);
    await inbox.tick();
    expect(script.requests).toHaveLength(1);
  });

  test("one list call per mailbox per round", async () => {
    const script = scriptedAdapter([message("a", T1)]);
    await build({ adapter: script.adapter }).tick();
    expect(script.requests).toHaveLength(1);
  });
});

describe("alerts to the owner", () => {
  const owner = () => {
    const notices: string[] = [];
    const settings = () => parseDeliverySettings(null, {});
    const raise = createOwnerAlert({ db, sender: Object.assign(async () => "delivered" as const, { registry: createDeliveryRegistry(db, time.now) }), settings, now: time.now, notice: (row) => notices.push(row.dedupeKey) });
    return { notices, alert: (a: InboxAlert) => { raise({ subject: a.subject, scope: a.scope, title: a.title, body: a.body }); } };
  };

  test("three failures in a row raise one alert, and two more rounds do not raise a second", async () => {
    const script = scriptedAdapter([]);
    script.state.failWith = new Error("boom");
    const { notices, alert } = owner();
    const inbox = build({ adapter: script.adapter, alert });
    for (let round = 0; round < 5; round++) {
      await inbox.tick();
      time.advance(CADENCE_MS);
      if (round === 1) expect(notices).toHaveLength(0);
    }
    expect(notices).toHaveLength(1);
  });

  test("a last good read older than 10 minutes with a wait open raises one alert", async () => {
    const script = scriptedAdapter([]);
    const { notices, alert } = owner();
    const inbox = build({ adapter: script.adapter, alert, openWaits: () => 1 });
    await inbox.tick();
    script.state.failWith = new Error("down");
    time.advance(11 * 60_000);
    await inbox.tick();
    time.advance(CADENCE_MS);
    await inbox.tick();
    expect(notices.filter((key) => key.includes(":stale"))).toHaveLength(1);
  });

  test("no open wait, no staleness alert", async () => {
    const script = scriptedAdapter([]);
    const inbox = build({ adapter: script.adapter });
    await inbox.tick();
    script.state.failWith = new Error("down");
    time.advance(11 * 60_000);
    await inbox.tick();
    expect(alerts).toHaveLength(0);
  });
});

describe("two servers on one file", () => {
  test("only one round runs at a time", async () => {
    const script = scriptedAdapter([message("a", T1)]);
    let release: () => void = () => {};
    script.state.gate = new Promise<void>((resolve) => { release = resolve; });
    const other = testDb.open();
    const first = build({ adapter: script.adapter }, db);
    const second = createInbox({ db: other, now: time.now, mailboxes: () => [mailbox()], adapterFor: () => script.adapter, alert: () => {}, owner: "server-b" });
    const running = first.readMailbox(mailbox());
    await Bun.sleep(20);
    expect(await second.readMailbox(mailbox())).toBe("busy");
    release();
    expect(await running).toBe("read");
    expect(script.requests).toHaveLength(1);
    expect(rows(other)).toHaveLength(1);
  });
});

describe("the write is fast on a full table", () => {
  test("with 10,000 rows, writing a message and matching it stays under 5 ms", () => {
    const insert = db.prepare("INSERT INTO mail_messages (mailbox, provider_id, from_addr, received_at) VALUES ('box', ?, 'x@example.test', ?)");
    db.transaction(() => { for (let i = 0; i < 10_000; i++) insert.run(`seed-${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()); })();
    const timings: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      commitRound(db, {
        mailbox: "box", messages: [message(`new-${i}`, T3)], cursor: String(i), now: time.now(), isOwn: () => false,
        // Stands for the matcher of the waits: the lookup it will do on the received rows.
        onStored: (fresh) => { db.query("SELECT id FROM mail_messages WHERE mailbox = 'box' AND received_at >= ? AND from_addr = ? LIMIT 5").all(T3, fresh[0]!.from); },
      });
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)]!;
    console.log(`[measure] write + match on 10000 rows: median ${median.toFixed(2)} ms, max ${timings[timings.length - 1]!.toFixed(2)} ms`);
    expect(median).toBeLessThan(5);
  });
});
