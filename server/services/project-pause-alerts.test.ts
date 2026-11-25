/**
 * The owner's channel outside the app: argv-only, text on stdin, empty
 * command = no process; and the two confirmations' own contract
 * ("Continua" buys more points, "Pausa fino a domani" holds until midnight),
 * named here by the acceptance bar even though their unit tests already live
 * in `project-pause.test.ts` next to the functions themselves.
 * @covers USAGE-30
 */
import { describe, expect, test } from "bun:test";
import {
  CONTINUE_GRACE_PCT, continueProject, nextLocalMidnight, openPauseIfNeeded, pauseUntilTomorrow, readProjectQuotaRow,
} from "./project-pause";
import { parseOwnerAlertCommand, pauseAlertText, sendOwnerAlert } from "./project-pause-alerts";
import { Database } from "bun:sqlite";
import { join } from "node:path";

describe("parseOwnerAlertCommand", () => {
  test("unset or empty: no command", () => {
    expect(parseOwnerAlertCommand({})).toBeNull();
    expect(parseOwnerAlertCommand({ TOPICS_OWNER_ALERT_COMMAND: "" })).toBeNull();
  });
  test("malformed JSON or a non-array: no command", () => {
    expect(parseOwnerAlertCommand({ TOPICS_OWNER_ALERT_COMMAND: "{not json" })).toBeNull();
    expect(parseOwnerAlertCommand({ TOPICS_OWNER_ALERT_COMMAND: '"just a string"' })).toBeNull();
  });
  test("a JSON array of strings is the argv", () => {
    expect(parseOwnerAlertCommand({ TOPICS_OWNER_ALERT_COMMAND: '["jarvis-channels","send-to","whatsapp","main"]' }))
      .toEqual(["jarvis-channels", "send-to", "whatsapp", "main"]);
  });
});

describe("sendOwnerAlert", () => {
  test("null argv (command empty/unset): spawns nothing", () => {
    let called = 0;
    sendOwnerAlert(null, "text", { spawn: (() => { called++; return {} as never; }) as never });
    expect(called).toBe(0);
  });

  test("runs the resolved executable with the rest as argv, and the text on stdin", () => {
    const calls: Array<{ exe: string; args: string[]; input: string }> = [];
    sendOwnerAlert(["mycmd", "send-to", "whatsapp"], "ciao", { // allow-italian: test fixture text
      resolve: (name) => `/resolved/${name}`,
      spawn: ((exe: string, args: string[], opts: { input: string }) => {
        calls.push({ exe, args, input: opts.input });
        return { status: 0, error: undefined, stderr: Buffer.from("") } as never;
      }) as never,
    });
    expect(calls).toEqual([{ exe: "/resolved/mycmd", args: ["send-to", "whatsapp"], input: "ciao" }]); // allow-italian: test fixture text
  });

  test("a failed spawn only warns, never throws", () => {
    expect(() => sendOwnerAlert(["mycmd"], "x", {
      resolve: (name) => name,
      spawn: (() => ({ status: 1, error: undefined, stderr: Buffer.from("boom") })) as never,
    })).not.toThrow();
  });
});

describe("pauseAlertText", () => {
  test("names the project, the points and the limit, and carries the link", () => {
    const text = pauseAlertText({ projectName: "topics-app", points24h: 10.4, limit: 10, link: "http://x/p" });
    expect(text).toContain("topics-app");
    expect(text).toContain("10.4");
    expect(text).toContain("10");
    expect(text).toContain("http://x/p");
  });
});

describe("the two confirmations (named by the acceptance bar; see project-pause.test.ts for the full unit coverage)", () => {
  const MIGRATION = Bun.file(join(import.meta.dir, "../db/migrations/20261119000000-project-quota.sql"));
  async function makeDb(): Promise<Database> {
    const db = new Database(":memory:");
    db.exec(await MIGRATION.text());
    return db;
  }

  test("'Continua' unblocks for CONTINUE_GRACE_PCT more points, everywhere a read sees the row", async () => {
    const db = await makeDb();
    openPauseIfNeeded(db, "p", 10.4);
    continueProject(db, "p", 10.4);
    const row = readProjectQuotaRow(db, "p")!;
    expect(row.pausedAt).toBeNull();
    expect(row.continuedUntilPct).toBeCloseTo(10.4 + CONTINUE_GRACE_PCT, 5);
  });

  test("'Pausa fino a domani' holds until local midnight, regardless of points", async () => {
    const db = await makeDb();
    const now = Date.now();
    pauseUntilTomorrow(db, "p", now);
    const row = readProjectQuotaRow(db, "p")!;
    expect(row.holdUntil).toBe(nextLocalMidnight(now));
  });
});
