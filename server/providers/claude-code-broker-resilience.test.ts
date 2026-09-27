/**
 * "The turn must reach the end" — the two ways a broker turn silently stopped
 * arriving, both driven end-to-end through a REAL ai-bridge daemon.
 *
 * 1. Re-spawn onto a surviving child. A server restart clears the provider's
 *    process map but the daemon keeps the `claude` child alive by design, so
 *    the next turn re-spawns onto it. The daemon's idempotent branch acked the
 *    pid without attaching the caller, so stdin reached the child, the child
 *    answered, and the answer went to sockets that no longer existed: the chat
 *    hung on "stream lento — il provider è ancora connesso" forever.
 *
 * 2. An attachment lost mid-turn (a socket reconnect, or any future variant).
 *    Same picture from outside: a child that is alive and working, a turn that
 *    never ends. `resyncStream` re-attaches from the last consumed byte and the
 *    missed output is replayed, so the turn still lands.
  * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-resilience-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

/** Fake stream-json CLI that STAYS ALIVE across turns (the real one does too):
 *  one `result` per stdin line, after `delaySec` so a test can steal the
 *  attachment before the answer is written. */
function writeFakeCli(name: string, delaySec: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, `#!/bin/sh
while read line; do
  [ "${delaySec}" = "0" ] || sleep ${delaySec}
  printf '{"type":"result","result":"pong","usage":{"input_tokens":3,"output_tokens":5},"duration_ms":2,"total_cost_usd":0}\\n'
done
`);
  chmodSync(p, 0o755);
  return p;
}

function handlerResolving(resolve: () => void, reject: (e: Error) => void, sink: { result: string | null }) {
  return {
    onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
    onSubAgentUpdate: () => {}, onUserInputRequired: () => {}, onAborted: () => {},
    onDone: (d: any) => { sink.result = d.result; resolve(); },
    onError: (e: string) => reject(new Error(e)),
  } as any;
}

async function seedTopic(sessionKey: string, id: string) {
  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT);
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT OR IGNORE INTO topics (id, name, slug, session_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, id, sessionKey, now, now);
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-resilience-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", SOCK);
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
});

afterAll(async () => {
  // Dispose the client FIRST: killing the daemon with a live client would trip
  // the auto-reconnect and respawn a daemon that outlives the test process.
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* not opened */ }
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* gone */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("claude-code provider · broker turns always reach the end", () => {
  test("a turn sent AFTER a restart, onto the child the daemon kept alive, still completes", async () => {
    const sessionKey = "topic:resilience-respawn";
    await seedTopic(sessionKey, "t-resp");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-claude-fast.sh", "0"));
    const { ClaudeCodeProvider } = await import("./claude-code");

    // Turn 1 — spawns the child in the daemon.
    const first = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    first.start();
    const s1 = { result: null as string | null };
    await new Promise<void>((res, rej) => { first.sendChat(sessionKey, "uno", handlerResolving(res, rej, s1)).catch(rej); });
    expect(s1.result).toBe("pong");

    // Restart: stop() DETACHES (the child survives on purpose), the map is dropped.
    first.stop();

    // Turn 2 on a FRESH provider — the daemon hands back the same live child.
    const second = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    second.start();
    const s2 = { result: null as string | null };
    await new Promise<void>((res, rej) => { second.sendChat(sessionKey, "due", handlerResolving(res, rej, s2)).catch(rej); });
    expect(s2.result).toBe("pong"); // pre-fix: never resolves, the turn hangs

    second.stop();
  }, 30000);

  test("resyncStream recovers a turn whose attachment was lost mid-flight", async () => {
    const sessionKey = "topic:resilience-resync";
    await seedTopic(sessionKey, "t-resy");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-claude-slow.sh", "1"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");

    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    const sink = { result: null as string | null };
    const turn = new Promise<void>((res, rej) => {
      provider.sendChat(sessionKey, "tre", handlerResolving(res, rej, sink)).catch(rej);
    });

    // Steal the attachment while the child is still thinking: from here on the
    // daemon has nobody to deliver this session's stdout to. This is the wedge.
    await new Promise((r) => setTimeout(r, 300));
    getAiBridgeClient().detach(sessionKey);

    // The answer is written to the store while we are deaf.
    await new Promise((r) => setTimeout(r, 1500));
    expect(sink.result).toBeNull();

    // The self-heal the watchdogs now call instead of just extending the grace.
    expect(await provider.resyncStream(sessionKey)).toBe(true);
    await turn;
    expect(sink.result).toBe("pong");

    provider.stop();
  }, 30000);

  test("a child gone under the SAME daemon ends as process-died: only a new daemon makes it broker-died", async () => {
    // The daemon forgets a session on an explicit kill and when its sweep reaps
    // a dead child: missing, with no daemon death. `broker-died` is resumed up
    // to four times, each one a paid turn, so a child that failed by itself
    // must not wear it.
    const sessionKey = "topic:resilience-child-death";
    await seedTopic(sessionKey, "t-child");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-claude-child-death.sh", "30"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");

    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    let ended = null as string | null;
    const turn = provider.sendChat(sessionKey, "cinque", {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
      onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
      onAborted: (info: any) => { ended = info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "aborted"; },
      onDone: () => { ended = "done"; },
      onError: () => { ended = "error"; },
    } as any).catch((e: Error) => { ended = ended ?? `rejected:${e.message}`; return {}; });

    await new Promise((r) => setTimeout(r, 400));
    const daemon = getAiBridgeClient().daemonPid;
    // The daemon drops the session at once; the client drops its handler, so
    // no `exit` frame reaches the provider and only the resync can tell.
    getAiBridgeClient().kill(sessionKey);
    expect(await provider.resyncStream(sessionKey)).toBe(false);
    await turn;
    expect(getAiBridgeClient().daemonPid).toBe(daemon);
    expect(ended).toBe("process-died");

    provider.stop();
  }, 30000);

  test("a spawn that finds the old daemon still answering is no new daemon: a child gone under it is process-died", async () => {
    // One failed connect with the daemon alive (a slow accept under load) is
    // enough for the client to spawn another. The new one finds the old one
    // healthy and exits, and the client reconnects to the old one: nothing
    // died. Counting spawns, a child that later vanished under that same
    // daemon ended as `broker-died` and was resent up to four times, each one
    // a paid turn (verifier of 27/09: "epoch 1 -> 2, pid 59814 -> 59814").
    const sessionKey = "topic:resilience-spurious-spawn";
    await seedTopic(sessionKey, "t-spur");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-claude-spurious-spawn.sh", "30"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");

    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    let ended = null as string | null;
    const turn = provider.sendChat(sessionKey, "sei", {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
      onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
      onAborted: (info: any) => { ended = info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "aborted"; },
      onDone: () => { ended = "done"; },
      onError: () => { ended = "error"; },
    } as any).catch((e: Error) => { ended = ended ?? `rejected:${e.message}`; return {}; });
    await new Promise((r) => setTimeout(r, 400));

    const client = getAiBridgeClient() as any;
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    const daemonPid = readFileSync(pidPath, "utf8").trim();
    const realTryConnect = client.tryConnect;
    let failed = false;
    client.tryConnect = function (this: unknown) {
      if (!failed) { failed = true; return Promise.resolve(false); }
      return realTryConnect.call(this);
    };
    try {
      client.socket.destroy();
      const until = Date.now() + 10_000;
      while (!(failed && client.ready) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(failed && client.ready).toBe(true);
    } finally {
      delete client.tryConnect;
    }
    expect(readFileSync(pidPath, "utf8").trim()).toBe(daemonPid);
    expect(String(getAiBridgeClient().daemonPid)).toBe(daemonPid);

    getAiBridgeClient().kill(sessionKey);
    expect(await provider.resyncStream(sessionKey)).toBe(false);
    await turn;
    expect(ended).toBe("process-died");

    provider.stop();
  }, 30000);

  test("a turn whose daemon dies mid-flight ENDS (it does not hang believing the child is alive)", async () => {
    const sessionKey = "topic:resilience-daemon-death";
    await seedTopic(sessionKey, "t-dead");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli("fake-claude-verylong.sh", "30"));
    const { ClaudeCodeProvider } = await import("./claude-code");

    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    // Widened on purpose: assigned in callbacks, so the compiler would narrow it to `null`.
    let ended = null as string | null;
    const turn = provider.sendChat(sessionKey, "quattro", {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
      onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
      onAborted: (info: any) => { ended = info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "aborted"; },
      onDone: () => { ended = "done"; },
      onError: () => { ended = "error"; },
    } as any).catch((e: Error) => { ended = ended ?? `rejected:${e.message}`; return {}; });

    // The daemon (and with it the child) disappears while the turn is open. No
    // `exit` frame can ever arrive — the sender of that frame is what died.
    await new Promise((r) => setTimeout(r, 400));
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");

    // The client reconnects (respawning an empty daemon), the provider re-attaches
    // its live sessions, and the "no such session" answer finalizes the turn.
    // As `broker-died`, not `process-died`: the child did not fail, the daemon
    // holding it went away, and the resume acts on that cause. On 25/09 at
    // 12:57 four chats ended "as died" this way and stayed stopped (51fb9359).
    await turn;
    expect(ended).toBe("broker-died");

    provider.stop();
  }, 30000);
});
