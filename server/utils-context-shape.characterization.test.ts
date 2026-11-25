/**
 * Characterization test for `createAppContext`: the members it returns, the kind
 * and arity of each, and an end-to-end message round trip through the thread,
 * branch and stream helpers. Pinned before `server/utils.ts` was split into
 * `server/app-context/*`, so a structural move that drops, renames or rewires a
 * member turns this red.
 * @covers UNREAD-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, Topic } from "./types";

// DATA_DIR is shared process state (see utils-topic-save.test.ts): restore it.
const DATA_DIR_BEFORE = process.env.DATA_DIR;
let tmpRoot: string;
let ctx: AppContext;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ctx-shape-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.APP_DATA_DIR = join(tmpRoot, "app-data");
  ctx = createAppContext(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* test teardown: the db may already be closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* test teardown: temp dir may already be gone */ }
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

/** Each member as `name:kind[/arity]`, sorted: paths and the db handle vary per run, their kind does not. */
function shape(c: AppContext): string[] {
  return Object.entries(c as unknown as Record<string, unknown>)
    .map(([k, v]) => `${k}:${typeof v === "function" ? `function/${v.length}` : v === null ? "null" : typeof v}`)
    .sort();
}

describe("createAppContext shape", () => {
  test("returns the same members with the same kind and arity", () => {
    expect(shape(ctx)).toMatchSnapshot();
  });

  test("a message round trip goes through the thread, branch and stream helpers", () => {
    const now = new Date().toISOString();
    const topic: Topic = {
      id: "t-shape", name: "Shape", slug: "shape", parentId: null, links: [],
      sessionKey: "topic:t-shape", color: "#aabbcc", icon: "chat",
      createdAt: now, updatedAt: now, archived: false,
    };
    ctx.saveSingleTopic(topic);
    const key = topic.sessionKey;
    const user = ctx.appendLocalMessage(key, "user", "hello");
    const partial = ctx.createPartialMessage(key, "assistant");
    ctx.startStream(key, partial.id);
    expect(ctx.isStreaming(key)?.messageId).toBe(partial.id);
    ctx.appendToLastMessage(key, "world");
    ctx.finalizeLastMessage(key);
    ctx.endStream(key);
    expect(ctx.isStreaming(key)).toBeUndefined();

    const thread = ctx.loadLocalMessages(key);
    expect(thread.map((m) => [m.role, m.content, !!m.partial])).toEqual([["user", "hello", false], ["assistant", "world", false]]);
    expect(ctx.countMessagesBySession(key)).toBe(2);
    expect(ctx.getMessageById(partial.id)?.content).toBe("world");
    expect(ctx.getMessageSessionKey(partial.id)).toBe(key);
    expect(ctx.getSiblingMessages(user.id).map((m) => m.id)).toEqual([partial.id]);
    expect(ctx.loadThreadWindow(key, 1, 0).messages.map((m) => m.id)).toEqual([partial.id]);
  });
});
