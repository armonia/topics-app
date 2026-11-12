/**
 * The one-time JSONL migration (a session with no local messages yet, falling
 * back to the legacy gateway transcript) used to skip malformed lines with a
 * bare `catch {}` and then persist the partial transcript with
 * `appendLocalMessage` — no count, no warning, even though the outer catch of
 * the same migration does log.
 *
 * @covers AGCFG-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createHistoryRouter } from "./history";
import type { AppContext } from "../types";

const ROOT = testTmpDir("history-jsonl-migration");
let ctx: AppContext;
let sessionsDir: string;

beforeAll(async () => {
  sessionsDir = join(ROOT, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.SESSIONS_DIR = sessionsDir;
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(() => {
  delete process.env.SESSIONS_DIR;
  cleanupTestDataDir(ROOT);
});

function router() {
  return createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: this path only reaches the JSONL fallback"); },
  });
}

async function getHistory(sessionKey: string) {
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const url = new URL(`http://topics.test${path}`);
  const resp = (await router()(new Request(url, { method: "GET" }), url, path, "GET"))!;
  return { status: resp.status, body: await resp.json() };
}

describe("the JSONL migration fallback", () => {
  test("a malformed line is skipped and logged by count, the rest still migrates", async () => {
    const sessionKey = `topic:jsonlmig-${crypto.randomUUID()}`;
    writeFileSync(join(sessionsDir, "sessions.json"), JSON.stringify({ [sessionKey]: { sessionId: "sess-partial" } }));
    const lines = [
      "{not json at all",
      JSON.stringify({ type: "message", message: { role: "user", content: "survives the bad line" } }),
    ];
    writeFileSync(join(sessionsDir, "sess-partial.jsonl"), lines.join("\n"));

    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = ((...args: unknown[]) => { warnCalls.push(args); }) as never;
    let r: Awaited<ReturnType<typeof getHistory>>;
    try {
      r = await getHistory(sessionKey);
    } finally {
      console.warn = realWarn;
    }

    expect(r.status).toBe(200);
    expect((r.body as { messages: Array<{ content: string }> }).messages.map((m) => m.content)).toEqual(["survives the bad line"]);
    expect(warnCalls.some((args) => String(args[0]).includes("skipped") && String(args[0]).includes(sessionKey))).toBe(true);
  });
});
