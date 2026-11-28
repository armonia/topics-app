/**
 * @covers USAGE-29
 */
import { describe, expect, test } from "bun:test";
import { aggregateSessions as aggregate, modelFactor, addLine, type SessionTotals } from "./top-sessions";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const turn = (h: number, model: string, out: number, ctx = 1000) =>
  JSON.stringify({ type: "assistant", timestamp: ago(h), message: { model, usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: ctx } } });
const head = (h: number, cwd: string, entrypoint: string, title?: string) =>
  [JSON.stringify({ type: "user", timestamp: ago(h), cwd, entrypoint, message: { content: "first question" } }), title ? JSON.stringify({ type: "custom-title", customTitle: title }) : ""].join("\n");

interface Transcript { sessionId: string; subagent: boolean; text: string }
const file = (sessionId: string, text: string, subagent = false): Transcript => ({ sessionId, subagent, text });

const aggregateSessions = (files: Transcript[], now: number) => {
  const totals: SessionTotals = new Map();
  for (const f of files) for (const line of f.text.split("\n")) addLine(totals, f.sessionId, f.subagent, line, now);
  return aggregate(totals, now);
};

describe("aggregateSessions", () => {
  test("ranks by weighted points and folds subagents into the parent", () => {
    const files = [
      file("aaaa1111", [head(50, "/w/one", "claude-desktop", "Big refactor"), turn(1, "claude-opus-4", 1000)].join("\n")),
      file("aaaa1111", turn(2, "claude-opus-4", 1000), true),
      file("bbbb2222", [head(3, "/w/two", "cli"), turn(1, "claude-sonnet-4", 1000)].join("\n")),
    ];
    const { sessions } = aggregateSessions(files, NOW);
    expect(sessions.map((s) => s.id)).toEqual(["aaaa1111", "bbbb2222"]);
    expect(sessions[0].title).toBe("Big refactor");
    expect(sessions[0].origin).toBe("desktop");
    expect(sessions[1].title).toBe("first question");
    expect(sessions[1].origin).toBe("cli");
    // two opus turns (one from the subagent) against one sonnet turn
    expect(sessions[0].points24h).toBeGreaterThan(sessions[1].points24h * 2);
    expect(sessions[0].avgContext).toBe(1000);
  });

  test("flags a session that is at least half of a project, and a long-open hog", () => {
    const files = [
      file("big00000", [head(40, "/w/p", "cli"), turn(1, "claude-opus-4", 5000)].join("\n")),
      file("small000", [head(2, "/w/p", "cli"), turn(1, "claude-opus-4", 100)].join("\n")),
    ];
    const [big, small] = aggregateSessions(files, NOW).sessions;
    expect(big.dominatesProject).toBe(true);
    expect(big.hog).toBe(true);
    expect(small.dominatesProject).toBe(false);
    expect(small.hog).toBe(false);
  });

  test("a lone session is not a project domination; old records and garbage are ignored", () => {
    const files = [file("solo0000", [head(5, "/w/x", "cli"), "not json", turn(30, "claude-opus-4", 9000), turn(1, "claude-haiku-4", 10)].join("\n"))];
    const [s] = aggregateSessions(files, NOW).sessions;
    expect(s.dominatesProject).toBe(false);
    expect(s.points24h).toBe(Math.round(50 * 0.25 + 0.1 * 1000 * 0.25));
    expect(aggregateSessions([], NOW).sessions).toEqual([]);
  });

  test("model factors", () => {
    expect(modelFactor("claude-opus-4")).toBe(5);
    expect(modelFactor("claude-haiku-4")).toBe(0.25);
    expect(modelFactor("mystery")).toBe(1);
  });
});
