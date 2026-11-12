/**
 * The legacy JSONL search fallback (pre-SQLite transcripts) used to swallow
 * every failure with a bare `catch {}`: a malformed line, an unreadable
 * session file, or a corrupt `sessions.json` all vanished with no trace and
 * search just returned fewer results, silently.
 *
 * @covers AGCFG-02
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, Topic } from "./types";

let tmpRoot: string;
let sessionsDir: string;
let ctx: AppContext;

const SK = "topic:searchlegacy01";

function seedTopic() {
  const now = new Date().toISOString();
  const topic: Topic = {
    id: "search-legacy-0000-0000-0000-000000000001",
    name: "Legacy search",
    slug: "legacy-search",
    parentId: null,
    links: [],
    sessionKey: SK,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "search-legacy-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  sessionsDir = join(tmpRoot, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.APP_DATA_DIR = join(tmpRoot, "app-data");
  process.env.SESSIONS_DIR = sessionsDir;
  ctx = createAppContext(tmpRoot);
  seedTopic();
});

afterAll(() => {
  try { closeDatabase(); } catch { /* test teardown: the db may already be closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* test teardown: temp dir may already be gone */ }
});

let warnCalls: unknown[][] = [];
const realWarn = console.warn;
afterEach(() => {
  console.warn = realWarn;
  warnCalls = [];
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
});

function spyWarn() {
  console.warn = ((...args: unknown[]) => { warnCalls.push(args); }) as never;
}

describe("legacy JSONL transcript search", () => {
  test("a malformed line in the transcript is skipped, the rest still matches", () => {
    writeFileSync(join(sessionsDir, "sessions.json"), JSON.stringify({ [SK]: { sessionId: "sess-ok" } }));
    const lines = [
      "{not json at all",
      JSON.stringify({ type: "message", message: { role: "user", content: "needle in a haystack" } }),
    ];
    writeFileSync(join(sessionsDir, "sess-ok.jsonl"), lines.join("\n"));
    const hits = ctx.searchTranscripts("needle");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("needle");
  });

  test("a corrupt sessions.json is logged and the search still returns SQLite hits", () => {
    spyWarn();
    writeFileSync(join(sessionsDir, "sessions.json"), "{not json");
    const hits = ctx.searchTranscripts("anything");
    expect(hits).toEqual([]);
    expect(warnCalls.some((args) => String(args[0]).includes("sessions.json"))).toBe(true);
  });

  test("an unreadable session transcript is logged and does not crash the whole search", () => {
    spyWarn();
    writeFileSync(join(sessionsDir, "sessions.json"), JSON.stringify({ [SK]: { sessionId: "sess-bad" } }));
    // A directory where the transcript file is expected: `readFileSync` throws
    // EISDIR, which is a real fault, not "nothing written yet".
    mkdirSync(join(sessionsDir, "sess-bad.jsonl"));
    const hits = ctx.searchTranscripts("anything");
    expect(hits).toEqual([]);
    expect(warnCalls.some((args) => String(args[0]).includes("session"))).toBe(true);
  });
});
