/**
 * MuseProvider driven by a fake `muse exec` (a real process).
 *
 * The fixture (`muse/fake-muse.fixture.ts`) replays the wire measured on the
 * meta provider: `payload_type` + `payload` envelope, deltas, tools via task
 * events + `tool.result`, `run.terminal.*` close. This covers what the unit
 * tests never touch — spawn, argv, prompt from file, sid resume, abort of a
 * live turn, exit≠0.
 *
 * @covers MUSE-02, MUSE-03, MUSE-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { _resetMuseBinCache } from "../lib/muse-bin";
import { MuseProvider } from "./muse";
import type { StreamHandler } from "./types";

let tempRoot: string;
const previousBin = process.env.MUSE_BIN;
const previousDataDir = process.env.XDG_DATA_HOME;

function seedTopic(sessionKey: string): void {
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO topics
    (id, name, slug, session_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sessionKey, "Test", sessionKey, sessionKey, now, now);
}

function storedSid(sessionKey: string): string | null {
  const row = getDatabase()
    .prepare(`SELECT muse_session_id FROM muse_sessions WHERE session_key = ?`)
    .get(sessionKey) as { muse_session_id?: string } | null;
  return row?.muse_session_id ?? null;
}

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "topics-muse-integration-")));
  initDatabase(join(import.meta.dir, "..", ".."), tempRoot);

  // Muse data home in tmp: the orphan-log guard must neither see nor write
  // the real `~/.local/share/muse/sessions`.
  process.env.XDG_DATA_HOME = join(tempRoot, "xdg");

  // The wrapper names bun by absolute path: the CLI env is pruned.
  const wrapper = join(tempRoot, "fake-muse");
  const script = join(import.meta.dir, "muse", "fake-muse.fixture.ts");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.MUSE_BIN = wrapper;
  _resetMuseBinCache();
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.MUSE_BIN; else process.env.MUSE_BIN = previousBin;
  if (previousDataDir === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousDataDir;
  _resetMuseBinCache();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
});

interface Recording {
  handler: StreamHandler;
  texts: string[];
  starts: { id: string; name: string }[];
  results: { id: string; result: string; error: boolean }[];
  errors: string[];
  done: Promise<string>;
  aborted: Promise<string>;
}

function recorder(): Recording {
  const texts: string[] = [];
  const starts: Recording["starts"] = [];
  const results: Recording["results"] = [];
  const errors: string[] = [];
  let resolveDone!: (r: string) => void;
  let resolveAborted!: (r: string) => void;
  const done = new Promise<string>((r) => { resolveDone = r; });
  const aborted = new Promise<string>((r) => { resolveAborted = r; });
  const handler: StreamHandler = {
    onTextDelta: (t) => { texts.push(t); },
    onToolStart: (id, name) => { starts.push({ id, name }); },
    onToolResult: (id, result, error) => { results.push({ id, result, error: !!error }); },
    onDone: (m) => resolveDone(m?.result ?? ""),
    onError: (e) => { errors.push(e); resolveDone(`error:${e}`); },
    onAborted: (m) => resolveAborted(m?.result ?? ""),
  } as StreamHandler;
  return { handler, texts, starts, results, errors, done, aborted };
}

/** A turn must never hang the suite: 15s and it gives up. */
function timed<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 15000)),
  ]);
}

describe("muse-integration", () => {
  test("a turn with delta+tool+terminal reaches the handler whole", async () => {
    const sessionKey = "topic:muse-int-basic";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "hello TOOL", tape.handler, {
        history: [
          { role: "user", content: "earlier turn" },
          { role: "assistant", content: "earlier reply" },
        ],
      });
      const result = await timed(tape.done, "onDone");
      expect(result).toContain("echo");
      // The prompt file carried the transcript (fresh turn + history).
      expect(result).toContain("earlier");
      expect(tape.texts.join("")).toContain("echo");
      expect(tape.starts).toEqual([{ id: "task-fake-read", name: "read_file" }]);
      expect(tape.results).toEqual([{ id: "task-fake-read", result: "fake file contents", error: false }]);
      expect(tape.errors).toEqual([]);
      // Fresh turn: the sid the CLI saw is the one stored for the resume.
      const sid = storedSid(sessionKey);
      expect(sid).toBeTruthy();
      expect(result).toContain(`[sid=${sid}`);
    } finally {
      provider.stop();
    }
  });

  test("resume reuses the sid and stops resending history", async () => {
    const sessionKey = "topic:muse-int-resume";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const history = [
        { role: "user" as const, content: "earlier turn" },
        { role: "assistant" as const, content: "earlier reply" },
      ];
      const first = recorder();
      await provider.sendChat(sessionKey, "first", first.handler, { history });
      const firstResult = await timed(first.done, "first onDone");
      expect(firstResult).toContain("history=yes");

      const second = recorder();
      await provider.sendChat(sessionKey, "second", second.handler, { history });
      const secondResult = await timed(second.done, "second onDone");
      // The resumed session carries native context: no markdown transcript.
      expect(secondResult).toContain("history=no");
      expect(secondResult).not.toContain("earlier turn");

      const sid = storedSid(sessionKey);
      expect(firstResult).toContain(`[sid=${sid}`);
      expect(secondResult).toContain(`[sid=${sid}`);
    } finally {
      provider.stop();
    }
  });

  test("an orphaned sid falls back fresh and is forgotten", async () => {
    const sessionKey = "topic:muse-int-orphan";
    seedTopic(sessionKey);
    const now = new Date().toISOString();
    getDatabase().prepare(`INSERT INTO muse_sessions
      (session_key, muse_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)`).run(sessionKey, "orphan-sid", now, now);
    // The log root exists but the sid dir does not: pruned, not unrecognised.
    mkdirSync(join(tempRoot, "xdg", "muse", "sessions", ".msp-view-v1"), { recursive: true });

    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "after prune", tape.handler, {
        history: [{ role: "user", content: "earlier turn" }],
      });
      const result = await timed(tape.done, "onDone");
      const sid = storedSid(sessionKey);
      expect(sid).toBeTruthy();
      expect(sid).not.toBe("orphan-sid");
      expect(result).toContain(`[sid=${sid}`);
      // Fresh means WITH history: the pruned session's memory is the transcript.
      expect(result).toContain("history=yes");
    } finally {
      provider.stop();
    }
  });

  test("a resume that dies mid-turn retries once fresh and forgets the dead sid", async () => {
    const sessionKey = "topic:muse-int-resume-fallback";
    seedTopic(sessionKey);
    const now = new Date().toISOString();
    // Dead sid, but its log dir EXISTS: the pre-turn guard picks resume, and
    // only the mid-turn failure converts it to fresh.
    mkdirSync(join(tempRoot, "xdg", "muse", "sessions", ".msp-view-v1", "dead-sid"), { recursive: true });
    getDatabase().prepare(`INSERT INTO muse_sessions
      (session_key, muse_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)`).run(sessionKey, "dead-sid", now, now);

    // The fixture cannot tell resume from fresh: the CRASH prompt kills the
    // resume attempt AND the provider's fresh retry. The assertions below are
    // that the dead sid is forgotten (no permanent break) and the error
    // surfaces once, from the retry.
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "boom CRASH", tape.handler);
      const result = await timed(tape.done, "onDone-or-error");
      expect(result).toContain("error:Muse exited with code 3");
      // The dead sid must not survive: otherwise every future turn repeats the
      // same failing resume forever.
      const sid = storedSid(sessionKey);
      expect(sid).not.toBe("dead-sid");
    } finally {
      provider.stop();
    }
  });

  test("abort closes a live turn clean", async () => {
    const sessionKey = "topic:muse-int-abort";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      const origDelta = tape.handler.onTextDelta;
      tape.handler.onTextDelta = (t, full) => {
        origDelta(t, full);
        if (t.includes("slow:started")) void provider.abort(sessionKey);
      };
      await provider.sendChat(sessionKey, "take long SLOW", tape.handler);
      const partial = await timed(tape.aborted, "onAborted");
      expect(partial).toContain("slow:started");
      expect(tape.errors).toEqual([]);
      expect(provider.ownsSession(sessionKey)).toBe(false);
    } finally {
      provider.stop();
    }
  });

  test("exit≠0 surfaces a generic error and never the stderr tail", async () => {
    const sessionKey = "topic:muse-int-crash";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "boom CRASH", tape.handler);
      const result = await timed(tape.done, "onError");
      expect(result).toBe("error:Muse exited with code 3");
      expect(tape.errors.join("\n")).not.toContain("sk-secret");
      expect(tape.errors.join("\n")).not.toContain("/etc/passwd");
    } finally {
      provider.stop();
    }
  });

  test("a failed run surfaces its reason", async () => {
    const sessionKey = "topic:muse-int-fail";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "doom FAIL", tape.handler);
      const result = await timed(tape.done, "onError");
      expect(result).toContain("error:Muse run failed: fake model exploded");
    } finally {
      provider.stop();
    }
  });

  test("exit 0 without a terminal event is an error, not a silent success", async () => {
    const sessionKey = "topic:muse-int-noterminal";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "quiet NOTERMINAL", tape.handler);
      const result = await timed(tape.done, "onError");
      expect(result).toBe("error:Muse turn ended without a terminal event");
    } finally {
      provider.stop();
    }
  });
  test("the CLI is spawned with the Topics bridge bound to this session", async () => {
    // RED BEFORE: `muse exec` has no --mcp-config and the provider passed
    // only the user's settings, so a Muse chat had no `topics` tools at all.
    const sessionKey = "topic:muse-int-mcp";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    try {
      const tape = recorder();
      await provider.sendChat(sessionKey, "check MCP", tape.handler, {});
      const result = await timed(tape.done, "onDone");
      expect(result).toContain(`mcp=stdio:--session-key=${sessionKey}`);
    } finally {
      provider.stop();
    }
  });
});
