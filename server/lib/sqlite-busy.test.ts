/**
 * A busy database must not take the server down from a timer or from a promise
 * nobody awaits (card 629398ee). The helpers are proved here in-process, the
 * exit codes in a child process (`sqlite-busy.paths.fixture.ts`), and each
 * fixed path is pinned to the helper by its own test: the stale-stream close,
 * the ask-user TTL, and (by source, since the route closure cannot be built in
 * a test) the chat route's two watchdogs, its final write and its auto-bind.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deliverAnswer } from "./ask-user-bridge";
import { finalizeStaleRowWhenFree } from "./closed-outside";
import { isSqliteBusy, warnIfBusy, writeWhenFree } from "./sqlite-busy";

const busy = () => Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY", errno: 5 });
const silent = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("writeWhenFree", () => {
  test("a write that goes through returns its value, synchronously", () => {
    expect(writeWhenFree("t", () => 42, { warn: silent })).toBe(42);
  });

  test("a busy refusal does not throw, and the write lands on a later try", async () => {
    let calls = 0;
    const warnings: string[] = [];
    const out = writeWhenFree("t", () => { calls++; if (calls < 3) throw busy(); return "ok"; }, { delaysMs: [5, 5, 5], warn: (m) => warnings.push(m) });
    expect(out).toBeUndefined();
    await sleep(60);
    expect(calls).toBe(3);
    expect(warnings).toHaveLength(2);
  });

  test("it gives up with a warning once the delays run out", async () => {
    let calls = 0;
    const warnings: string[] = [];
    writeWhenFree("t", () => { calls++; throw busy(); }, { delaysMs: [5], warn: (m) => warnings.push(m) });
    await sleep(40);
    expect(calls).toBe(2);
    expect(warnings.at(-1)).toContain("given up");
  });

  test("an error that is not busy is rethrown to the caller, as before", () => {
    expect(() => writeWhenFree("t", () => { throw new Error("no such table: x"); }, { warn: silent })).toThrow("no such table");
  });
});

describe("warnIfBusy", () => {
  test("a busy rejection becomes a warning", async () => {
    const warnings: string[] = [];
    await Promise.reject(busy()).catch(warnIfBusy("t", (m) => warnings.push(m)));
    expect(warnings[0]).toContain("skipped");
  });

  test("any other rejection stays a rejection", async () => {
    await expect(Promise.reject(new Error("boom")).catch(warnIfBusy("t", silent))).rejects.toThrow("boom");
  });

  test("isSqliteBusy reads the code, the extended codes and the message", () => {
    expect(isSqliteBusy(busy())).toBe(true);
    expect(isSqliteBusy({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
    expect(isSqliteBusy(new Error("x"))).toBe(false);
  });
});

describe("the server-shaped process", () => {
  const run = (mode: string, cure: string) => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-busy-"));
    try {
      const out = Bun.spawnSync([process.execPath, join(import.meta.dir, "sqlite-busy.paths.fixture.ts"), mode, cure, join(dir, "db.sqlite")], { stdout: "pipe", stderr: "pipe" });
      return { code: out.exitCode, stdout: out.stdout.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("bare, a busy write in a timer exits 7: the crash of the logs", () => {
    expect(run("timer", "bare").code).toBe(7);
  });
  test("cured, the timer stays up and the write lands", () => {
    const r = run("timer", "cured");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).closed).toBe(1);
  });
  test("bare, a busy write in a promise nobody awaits exits 1", () => {
    expect(run("promise", "bare").code).toBe(1);
  });
  test("cured, the promise stays up and the write lands", () => {
    const r = run("promise", "cured");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).closed).toBe(1);
  });
});

describe("path 1: the stale-stream sweep's close", () => {
  test("a busy close is retried on its own, since the stream already left the map", async () => {
    let runs = 0;
    const db = {
      run: () => { runs++; if (runs === 1) throw busy(); },
      query: () => ({ get: () => undefined }),
    };
    const args = { messageId: "m1", marker: null, interruption: { text: "x", cause: "watchdog" as const, at: "2026-11-14T00:00:00Z" } };
    expect(() => finalizeStaleRowWhenFree(db as never, args, { delaysMs: [5], warn: silent })).not.toThrow();
    await sleep(30);
    expect(runs).toBe(2);
  });
});

describe("path 6: an unclaimed answer meets a busy database", () => {
  test("the TTL timer does not throw, and the answer is delivered on a later try", async () => {
    let calls = 0;
    const delivered: Record<string, string>[] = [];
    deliverAnswer("topic:busy0001", { q: "yes" }, {
      bufferTtlMs: 5,
      onUnclaimed: (a) => { calls++; if (calls === 1) throw busy(); delivered.push(a); },
    });
    // TTL 5 ms, then the first retry of BUSY_RETRY_DELAYS_MS, one second.
    await sleep(1_200);
    expect(calls).toBe(2);
    expect(delivered).toEqual([{ q: "yes" }]);
  });
});

describe("paths 3, 4, 5, 7: the chat route", () => {
  const chat = readFileSync(join(import.meta.dir, "../routes/chat.ts"), "utf8");
  test("the grace and the hard timeout close the row through writeWhenFree", () => {
    expect(chat).toContain("writeWhenFree(`grace-expiry close of ${partialMsg.id}`, () => updateLastMessage(sessionKey, { content: fullContent, blocks: graceBlocks,");
    expect(chat).toContain("writeWhenFree(`hard-timeout close of ${partialMsg.id}`, () => updateLastMessage(sessionKey, { content: fullContent, blocks: hardBlocks,");
  });
  test("the deferred auto-bind goes through writeWhenFree", () => {
    expect(chat).toContain("writeWhenFree(`auto-bind of ${matchedTopic!.id}`, () => autoBindProject(matchedTopic!))");
  });
  test("finalizeStream's final write waits for the lock, and its unawaited calls catch busy", () => {
    expect(chat).toContain("const finalizedMsg = writeWhenFree(`final write of ${partialMsg.id}`, () => updateLastMessage(sessionKey, {");
    expect(chat.match(/void finalizeStream\([^\n]*\.catch\(warnIfBusy\(/g)?.length).toBe(3);
    // No bare call left: every `finalizeStream(` that is not its declaration is caught.
    expect(chat.match(/^\s*finalizeStream\(/gm)).toBeNull();
  });
});
