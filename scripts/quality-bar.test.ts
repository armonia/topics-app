/**
 * @covers TOPIC-01
 */
import { describe, expect, test } from "bun:test";
import { judgeBugIssues, judgeCiMain, judgeCrashLog, judgeCreateRoute, judgeE2eMain } from "./quality-bar";

// One healthy input and one mutant per measure: the mutant must turn it red.
describe("quality bar measures", () => {
  test("ci-main", () => {
    expect(judgeCiMain([{ status: "queued", conclusion: null, databaseId: 2 }, { status: "completed", conclusion: "success", databaseId: 1 }]).ok).toBe(true);
    expect(judgeCiMain([{ status: "completed", conclusion: "failure", databaseId: 1 }]).ok).toBe(false);
    expect(judgeCiMain(null).ok).toBe(false);
    expect(judgeCiMain([]).ok).toBe(false);
  });
  test("e2e-main", () => {
    const ok = [{ name: "e2e (0)", conclusion: "success" }, { name: "check", conclusion: "failure" }];
    expect(judgeE2eMain(ok).ok).toBe(true);
    expect(judgeE2eMain([{ name: "e2e (0)", conclusion: "failure" }]).ok).toBe(false);
    expect(judgeE2eMain([{ name: "check", conclusion: "success" }]).ok).toBe(false);
    expect(judgeE2eMain(null).ok).toBe(false);
  });
  test("bug-issues", () => {
    expect(judgeBugIssues(0).ok).toBe(true);
    expect(judgeBugIssues(1).ok).toBe(false);
    expect(judgeBugIssues(null).ok).toBe(false);
  });
  test("crash-log", () => {
    expect(judgeCrashLog("[WS] fine\nall quiet").ok).toBe(true);
    expect(judgeCrashLog(null).ok).toBe(true);
    expect(judgeCrashLog("ok\nSQLiteError: out of memory\nok").ok).toBe(false);
    // a crash line older than the tail window no longer counts
    const old = ["Uncaught boom", ...Array(5000).fill("fine")].join("\n");
    expect(judgeCrashLog(old).ok).toBe(true);
  });
  test("create-route", () => {
    expect(judgeCreateRoute(0).ok).toBe(true);
    expect(judgeCreateRoute(1).ok).toBe(false);
  });
});
