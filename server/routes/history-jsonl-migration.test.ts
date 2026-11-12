/**
 * GET /api/history/:sessionKey — one-time legacy JSONL migration (last resort
 * when a session has no local messages yet, server/routes/history.ts ~385).
 *
 * Regression: the migration silently skipped malformed JSONL rows and
 * persisted the PARTIAL transcript via `appendLocalMessage` — later reads use
 * that local copy, so a skipped row is lost for good, and the catch logged
 * nothing about how many rows were lost. Now it counts the skipped rows and
 * logs the count.
 */
import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";
import type { AppContext } from "../types";

const ROOT = testTmpDir("history-jsonl-migration");
const SESSIONS_DIR_PRIMA = process.env.SESSIONS_DIR;
let sessionsDir: string;

beforeAll(() => {
  setupTestDataDir(`${ROOT}/data`);
  sessionsDir = join(ROOT, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.SESSIONS_DIR = sessionsDir;
});
afterAll(async () => {
  await cleanupTestDataDir(ROOT);
  if (SESSIONS_DIR_PRIMA === undefined) delete process.env.SESSIONS_DIR; else process.env.SESSIONS_DIR = SESSIONS_DIR_PRIMA;
});

async function makeTopicSessionKey(ctx: AppContext, name: string): Promise<string> {
  const router = createTopicsRouter(ctx);
  const url = new URL("http://t.test/api/topics");
  const res = await router(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  }), url, url.pathname, "POST");
  const body = await res!.json();
  const sessionKey = ctx.getTopicById(body.id)?.sessionKey;
  if (!sessionKey) throw new Error("topic created with no sessionKey");
  return sessionKey;
}

async function getHistory(ctx: AppContext, sessionKey: string) {
  const router = createTopicsRouter(ctx);
  const url = new URL(`http://t.test/api/history/${encodeURIComponent(sessionKey)}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  return { status: res!.status, body: await res!.json() };
}

describe("JSONL migration counts and logs skipped lines", () => {
  test("valid lines migrate, malformed ones are counted and logged, not silently dropped", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = await makeTopicSessionKey(ctx, "jsonl-migration-topic");

    writeFileSync(join(sessionsDir, "sessions.json"), JSON.stringify({ [sessionKey]: { sessionId: "sess-migrate-1" } }));
    const lines = [
      "null",
      "{not json",
      JSON.stringify({ type: "message", message: { role: "user", content: "first valid line" }, timestamp: "2024-01-01T00:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "second valid line" }, timestamp: "2024-01-01T00:00:01Z" }),
    ];
    writeFileSync(join(sessionsDir, "sess-migrate-1.jsonl"), lines.join("\n"));

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { status, body } = await getHistory(ctx, sessionKey);
      expect(status).toBe(200);
      expect(body.messages.map((m: { content: string }) => m.content)).toEqual(["first valid line", "second valid line"]);

      const warnLines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(warnLines.some((l) => l.includes(`[History] migration skipped 2 malformed line(s) for session ${sessionKey}`))).toBe(true);
    } finally {
      warn.mockRestore();
    }

    const persisted = ctx.loadLocalMessages(sessionKey);
    expect(persisted.map((m) => m.content)).toEqual(["first valid line", "second valid line"]);
  });
});
