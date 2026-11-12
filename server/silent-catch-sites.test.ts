/**
 * Sites that used to swallow a real error (card 30f7c880). Each test makes the
 * real operation fail and checks that the failure shows: a captured log line or
 * an error to the caller.
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "./db";
import { createAppContext } from "./utils";
import { browserStateBaseDir, deleteStorageState } from "./browser-state-store";
import { markGroupStopping, commandProcessGroupStopPath } from "./lib/command-process-groups";
import { attachMediaOfTurn } from "./lib/attach-media-of-turn";
import { drainOutput } from "./lib/drain-output";
import { dispatchBridgeLine, killChildren, settleExitedSessionRow } from "./lib/terminal-guards";
import { removeDirReporting } from "./lib/remove-dir-reporting";
import { warnThrottled, warnThrottledSize } from "./lib/warn-throttled";

const ENV_KEYS = ["DATA_DIR", "TOPICS_DATA_DIR", "APP_DATA_DIR", "TOPICS_HOME", "GATEWAY_TOKEN"] as const;
const previousEnv = new Map<string, string | undefined>();
const roots: string[] = [];

function isolate(): string {
  closeDatabase();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "silent-catch-sites-")));
  roots.push(root);
  for (const key of ENV_KEYS) if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  process.env.DATA_DIR = join(root, "data");
  process.env.TOPICS_DATA_DIR = join(root, "state");
  process.env.APP_DATA_DIR = join(root, "appdata");
  process.env.TOPICS_HOME = join(root, "home");
  process.env.GATEWAY_TOKEN = "isolated-test-placeholder";
  return root;
}

afterEach(() => {
  closeDatabase();
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // Best effort: a just-closed SQLite file can stay locked for a moment on Windows.
  for (const root of roots.splice(0)) {
    // A file still locked is left in the OS temp dir.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (e) { console.debug("cleanup skipped", root, e instanceof Error ? e.message : e); }
  }
});

/** Every argument of every call, flattened to text. */
function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");
}

describe("db: schema_migrations backfill", () => {
  test("a failing backfill is logged as an error", () => {
    const root = isolate();
    const baseDir = join(import.meta.dir, "..");
    initDatabase(baseDir, root);
    closeDatabase();
    // An old database: tables exist, the registry is empty, and recording one
    // of the first eight migrations is refused.
    const raw = new Database(join(root, "data", "topics.db"));
    raw.run("DELETE FROM schema_migrations");
    raw.run("CREATE TRIGGER refuse_backfill BEFORE INSERT ON schema_migrations WHEN NEW.version <= 8 BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
    raw.close();

    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // The re-applied migrations may fail too: only the backfill report matters.
      const reopened = (() => { try { return initDatabase(baseDir, root); } catch (e) { return e; } })();
      expect(reopened).toBeDefined();
      expect(logged(error)).toContain("backfill failed");
      expect(logged(error)).toContain("database is locked");
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});

describe("utils: end-of-turn close of interrupted tools", () => {
  test("a refused UPDATE is logged with the session", () => {
    isolate();
    const ctx = createAppContext(join(import.meta.dir, ".."));
    const sessionKey = "silent-catch-session";
    const messageId = "silent-catch-message";
    const toolCalls = JSON.stringify([{ id: "t1", name: "Bash", status: "running", args: {} }]);
    ctx.db.run(
      "INSERT INTO messages (id, session_key, role, content, tool_calls, timestamp, sort_order) VALUES (?, ?, 'assistant', '', ?, ?, 1)",
      [messageId, sessionKey, toolCalls, new Date().toISOString()],
    );
    ctx.db.run("CREATE TRIGGER refuse_close BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
    ctx.startStream(sessionKey, messageId);

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      ctx.endStream(sessionKey);
      expect(logged(warn)).toContain(sessionKey);
      expect(logged(warn)).toContain("database is locked");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("attachMediaOfTurn", () => {
  test("a failing media scan is logged with the session key", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await attachMediaOfTurn({
        sessionKey: "media-session",
        topicId: undefined,
        requestStartMs: 0,
        toolsOfTurn: [],
        ownRow: { rowId: "r1" },
        findNewMediaFiles: async () => { throw new Error("scan exploded"); },
        updateLastMessageWithMedia: () => {},
        broadcast: () => {},
      });
      expect(logged(warn)).toContain("media-session");
      expect(logged(warn)).toContain("scan exploded");
    } finally {
      warn.mockRestore();
    }
  });

  test("a failing attach after a good scan is logged too", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await attachMediaOfTurn({
        sessionKey: "media-session-2",
        topicId: undefined,
        requestStartMs: 0,
        toolsOfTurn: [{ name: "Bash", args: { command: "make /tmp/shot.png" }, result: "wrote /tmp/shot.png" }],
        ownRow: { rowId: "r2" },
        findNewMediaFiles: async () => ["/tmp/shot.png"],
        updateLastMessageWithMedia: () => { throw new Error("db locked"); },
        broadcast: () => {},
      });
      expect(logged(warn)).toContain("db locked");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("drainOutput", () => {
  test("a reader that fails is logged with the process id", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("pipe broke")); },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drainOutput(stream, "proc-1", () => {});
      expect(logged(warn)).toContain("proc-1");
      expect(logged(warn)).toContain("pipe broke");
    } finally {
      warn.mockRestore();
    }
  });

  test("an appendOutput that throws is logged too", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("hello")); controller.close(); },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drainOutput(stream, "proc-2", () => { throw new Error("append failed"); });
      expect(logged(warn)).toContain("append failed");
    } finally {
      warn.mockRestore();
    }
  });

  test("a sink that throws on the first chunk does not stop the later chunks", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const c of ["one", "two", "three"]) controller.enqueue(enc.encode(c)); controller.close(); },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    try {
      await drainOutput(stream, "proc-multi", (t) => { seen.push(t); if (seen.length === 1) throw new Error("sink failed once"); });
      expect(seen).toEqual(["one", "two", "three"]);
      expect(logged(warn)).toContain("proc-multi");
    } finally {
      warn.mockRestore();
    }
  });

  test("a healthy stream is delivered whole and logs nothing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("a")); controller.enqueue(new TextEncoder().encode("b")); controller.close(); },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    try {
      await drainOutput(stream, "proc-3", (t) => seen.push(t));
      expect(seen.join("")).toBe("ab");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("terminal guards", () => {
  test("a bridge handler that throws is logged", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      dispatchBridgeLine('{"type":"exit"}', () => { throw new Error("handler exploded"); });
      expect(logged(warn)).toContain("handler exploded");
    } finally {
      warn.mockRestore();
    }
  });

  test("a line that does not parse is dropped without reaching the handler", () => {
    let calls = 0;
    dispatchBridgeLine("{not json", () => { calls++; });
    expect(calls).toBe(0);
  });

  test("an exited-session row that cannot be written is logged", () => {
    const db = new Database(":memory:"); // no terminal_sessions table: both statements throw
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      settleExitedSessionRow(() => db, { id: "term-park", resumable: true, exitCode: 1 });
      settleExitedSessionRow(() => db, { id: "term-delete", resumable: false, exitCode: null });
      expect(logged(warn)).toContain("term-park");
      expect(logged(warn)).toContain("term-delete");
    } finally {
      warn.mockRestore();
      db.close();
    }
  });

  test("an exited-session row is parked or deleted when the table works", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, status TEXT, exit_code INTEGER)");
    db.run("INSERT INTO terminal_sessions (id, status) VALUES ('a', 'running'), ('b', 'running')");
    settleExitedSessionRow(() => db, { id: "a", resumable: true, exitCode: 3 });
    settleExitedSessionRow(() => db, { id: "b", resumable: false, exitCode: null });
    expect(db.query("SELECT id, status, exit_code FROM terminal_sessions").all()).toEqual([{ id: "a", status: "dormant", exit_code: 3 }]);
    db.close();
  });

  test("a kill that throws is logged with the child id and the others still run", () => {
    const killed: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      killChildren([{ id: "child-a" }, { id: "child-b" }], "parent-key", (id) => {
        if (id === "child-a") throw new Error("bridge gone");
        killed.push(id);
      });
      expect(logged(warn)).toContain("child-a");
      expect(logged(warn)).toContain("bridge gone");
      expect(killed).toEqual(["child-b"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("command process groups: stop marker", () => {
  test("a marker that cannot be written is logged", () => {
    isolate();
    const processId = "stop-marker-proc";
    // A directory where the marker file should go: writeFileSync throws EISDIR.
    mkdirSync(commandProcessGroupStopPath(processId), { recursive: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      markGroupStopping(processId);
      expect(logged(warn)).toContain(processId);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("deleteStorageState", () => {
  test("a storage.json that cannot be unlinked is reported and thrown", async () => {
    isolate();
    const dir = join(browserStateBaseDir(), "undeletable");
    // A non-empty directory where the file should be: existsSync is true, unlink throws.
    mkdirSync(join(dir, "storage.json"), { recursive: true });
    writeFileSync(join(dir, "storage.json", "x"), "x");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(deleteStorageState("undeletable")).rejects.toBeDefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("removeDirReporting", () => {
  test("a removal that throws is reported with the path and answers false", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const removed = removeDirReporting("/legacy/hooks", () => { throw new Error("EBUSY"); });
      expect(removed).toBe(false);
      expect(logged(warn)).toContain("/legacy/hooks");
    } finally {
      warn.mockRestore();
    }
  });

  test("a removal that works answers true", () => {
    const dir = mkdtempSync(join(tmpdir(), "remove-dir-reporting-"));
    expect(removeDirReporting(dir)).toBe(true);
  });
});

describe("call sites keep the guards", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, p), "utf8");
  test("the routes go through the reporting helpers", () => {
    const terminal = read("routes/terminal.ts");
    expect(terminal).toContain("dispatchBridgeLine(");
    expect(terminal).toContain("settleExitedSessionRow(getDatabase,");
    expect(terminal).toContain("killChildren(");
    expect(read("routes/processes.ts")).toContain("drainOutput(stream, processId,");
    expect(read("../scripts/install-claude-hooks.ts")).toContain("removeDirReporting(");
  });
});

describe("warnThrottled", () => {
  test("expired keys are swept once the table is large", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const realNow = Date.now;
    try {
      const base = realNow();
      Date.now = () => base;
      for (let i = 0; i < 400; i++) warnThrottled(`sweep-many:${i}`, "x");
      Date.now = () => base + 61_000;
      warnThrottled("sweep-many:trigger", "x");
      expect(warnThrottledSize()).toBeLessThan(10);
    } finally {
      Date.now = realNow;
      warn.mockRestore();
    }
  });
});
