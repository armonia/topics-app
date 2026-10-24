/**
 * A CLAUDE CHAT COMES THROUGH SERVER RESTARTS WITH ITS TRANSCRIPT AND ITS SESSION.
 *
 * The week of 17-23/10 on the production machine: eleven restarts of the server,
 * all graceful reloads after a change to its sources, and one transcript lost.
 * The lost one was `d1a77950….jsonl` (topic:b528952e): idle since 22/09, deleted
 * by Claude Code's own 30-day cleanup on 22/10, and forgotten by the boot sweep
 * that followed (`[orphan-transcript] forgot unresumable session …`), so the
 * chat's next turn would have started from nothing but the DB recap.
 *
 * This runs the real server (`scripts/start-test-server.sh`) three times on one
 * data folder, with the ai-bridge broker on, as production does, and a fake CLI
 * that keeps its transcript like the real one (`helpers/fake-claude-transcript.ts`):
 *
 *   1. a first turn creates the session and its transcript;
 *   2. a second turn is under way when the server is SIGTERMed; the next boot
 *      finishes it, and the session and transcript are the same ones;
 *   3. the CLI's cleanup deletes the transcript of the now idle session, the
 *      server restarts again, and the session is still there, its transcript
 *      back whole, and the next turn resumes it (`--resume`, same id) with the
 *      memory of both earlier turns;
 *   4. a second chat with no project (the boot sweep cannot judge it) loses its
 *      transcript the same way: its next turn puts it back at the spawn. *
 * @covers RESUME-05
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { slackMs } from "../helpers/time-slack";

const REPO = resolve(import.meta.dir, "..", "..");
const TOKEN = "test-token";
// Unix socket paths have a 104-byte cap on macOS: /tmp, not os.tmpdir().
const DATA = mkdtempSync("/tmp/trs-");
const HOME = join(DATA, ".home");
const ARGV_LOG = join(DATA, "argv.log");
const PROJECT = join(DATA, "project");
let port = 0;
let server: ReturnType<typeof Bun.spawn> | null = null;
let boot = 0;

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

const base = () => `http://127.0.0.1:${port}`;

async function startServer(): Promise<void> {
  boot += 1;
  const logFd = openSync(join(DATA, `server-${boot}.log`), "w");
  server = Bun.spawn(["bash", join(REPO, "scripts", "start-test-server.sh")], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
      BUN_PORT: String(port),
      DATA_DIR: DATA,
      GATEWAY_TOKEN: TOKEN,
      TOPICS_AI_BRIDGE: "1",
      TOPICS_AI_BRIDGE_SOCKET: join(DATA, "ai.sock"),
      TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS: "60000",
      TOPICS_PTY_SOCKET: join(DATA, "pty.sock"),
      FAKE_CLI_ARGV_LOG: ARGV_LOG,
    },
    stdout: logFd,
    stderr: logFd,
  });
  closeSync(logFd);
  const until = Date.now() + slackMs(60_000);
  while (Date.now() < until) {
    const r = await fetch(`${base()}/api/topics`, { headers: { "X-Gateway-Token": TOKEN } }).catch(() => null);
    if (r?.ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`server boot ${boot} did not answer:\n${serverLog()}`);
}

/** SIGTERM, as the source watcher sends it in production, and wait for the exit. */
async function stopServer(): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(slackMs(30_000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
  server = null;
}

const serverLog = () => (existsSync(join(DATA, `server-${boot}.log`)) ? readFileSync(join(DATA, `server-${boot}.log`), "utf8") : "");

/** POST /api/chat; resolves when the stream ends (a restart ends it early, on purpose). */
function sendTurn(sessionKey: string, content: string): Promise<void> {
  return (async () => {
    const res = await fetch(`${base()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
    const reader = res.body.getReader();
    for (;;) if ((await reader.read()).done) break;
  })();
}

function db(): Database {
  return new Database(join(DATA, "topics.db"), { readonly: true });
}

function sessionRow(sessionKey: string): { claude_session_id: string } | null {
  const d = db();
  try {
    return d.query("SELECT claude_session_id FROM claude_code_sessions WHERE session_key = ?").get(sessionKey) as { claude_session_id: string } | null;
  } finally { d.close(); }
}

function assistantTexts(sessionKey: string): string[] {
  const d = db();
  try {
    return (d.query("SELECT content FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY sort_order").all(sessionKey) as { content: string }[])
      .map((r) => r.content);
  } finally { d.close(); }
}

async function waitFor(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + slackMs(ms);
  while (Date.now() < until) {
    try { if (check()) return; } catch { /* DB busy: ask again */ }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}\n--- server log ---\n${serverLog().slice(-4000)}`);
}

/** Every transcript the fake CLI wrote for `id`, wherever its cwd put it. */
function transcriptOf(id: string): string | null {
  const root = join(HOME, ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

const argvLines = (): string[][] =>
  existsSync(ARGV_LOG) ? readFileSync(ARGV_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];

beforeAll(() => {
  port = freePort();
  mkdirSync(PROJECT, { recursive: true });
  // The CLI the test server runs: start-test-server.sh writes its own stub
  // only when this file is missing, and points CLAUDE_BIN at it.
  mkdirSync(join(HOME, ".local", "bin"), { recursive: true });
  const cli = join(HOME, ".local", "bin", "claude");
  writeFileSync(cli, `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(import.meta.dir, "helpers", "fake-claude-transcript.ts")}" "$@"\n`);
  chmodSync(cli, 0o755);
});

afterAll(async () => {
  await stopServer();
  // The broker and the PTY bridge outlive the server by design; these are
  // found by the data folder in their command line, which only this file uses.
  // They write into the folder while they stop: remove it once they are gone.
  const ours = () => Bun.spawnSync(["pgrep", "-f", DATA]).stdout.toString().split("\n").filter(Boolean).map(Number);
  for (const pid of ours()) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 40 && ours().length > 0; i++) await Bun.sleep(250);
  for (const pid of ours()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  if (process.env.KEEP_TEST_DATA) return;
  // A child that only had the folder as its HOME (not in its command line)
  // can still create an empty `.home` while it exits: a second pass catches it.
  rmSync(DATA, { recursive: true, force: true });
  await Bun.sleep(2_000);
  rmSync(DATA, { recursive: true, force: true });
});

describe("a Claude chat across server restarts", () => {
  it("keeps its transcript and its session, mid-turn and after the CLI's 30-day cleanup", async () => {
    await startServer();
    const created = await fetch(`${base()}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      // A project folder, like the lost chat (cwd /Users/…/topics-app): the boot
      // sweep only judges sessions whose cwd it can resolve.
      body: JSON.stringify({ name: "Restart keeps session", provider: "claude-code", projectPath: PROJECT }),
    });
    expect(created.ok).toBe(true);
    const topic = (await created.json()) as { id: string; sessionKey?: string };
    const sk = topic.sessionKey ?? `topic:${topic.id.slice(0, 8)}`;

    const plain = await fetch(`${base()}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ name: "No project", provider: "claude-code" }),
    });
    const plainTopic = (await plain.json()) as { id: string; sessionKey?: string };
    const sk2 = plainTopic.sessionKey ?? `topic:${plainTopic.id.slice(0, 8)}`;

    // 1. A first turn: the session and its transcript are born.
    await sendTurn(sk, "first");
    await sendTurn(sk2, "first");
    await waitFor("the first answer of the chat with no project", () => assistantTexts(sk2).some((t) => t.includes("remembers:0")));
    const id2 = sessionRow(sk2)?.claude_session_id;
    expect(id2).toBeTruthy();
    await waitFor("the first answer", () => assistantTexts(sk).some((t) => t.includes("remembers:0")));
    const id = sessionRow(sk)?.claude_session_id;
    expect(id).toBeTruthy();
    expect(transcriptOf(id!)).not.toBeNull();

    // 2. A second turn under way when the server goes down, finished after the boot.
    const second = sendTurn(sk, "second SLOW:6000").catch(() => { /* the restart cuts this stream */ });
    await waitFor("the second turn to start", () => (readFileSync(transcriptOf(id!)!, "utf8").match(/"type":"user"/g) ?? []).length === 2, 15_000);
    await stopServer();
    await startServer();
    await second;
    await waitFor("the second answer after the restart", () => assistantTexts(sk).some((t) => t.includes("remembers:1")), 45_000);
    expect(sessionRow(sk)?.claude_session_id).toBe(id!);
    const whole = readFileSync(transcriptOf(id!)!, "utf8");
    expect(whole.match(/"type":"user"/g)?.length).toBe(2);
    expect(whole.match(/"type":"assistant"/g)?.length).toBe(2);

    // 3. Thirty idle days later the CLI's cleanup deletes the transcript, and the
    // server restarts. Older than the boot sweep's 5-minute grace, like the real one.
    await waitFor("the boot sweeps of the second server", () => serverLog().includes("[orphan-transcript] scanned"));
    await stopServer();
    unlinkSync(transcriptOf(id!)!);
    unlinkSync(transcriptOf(id2!)!);
    const w = new Database(join(DATA, "topics.db"));
    for (const key of [sk, sk2]) w.run("UPDATE claude_code_sessions SET updated_at = ? WHERE session_key = ?", [new Date(Date.now() - 31 * 86_400_000).toISOString(), key]);
    w.close();
    await startServer();
    await waitFor("the boot sweeps of the third server", () => serverLog().includes("[orphan-transcript] scanned"));

    expect(sessionRow(sk)?.claude_session_id, "the boot did not forget the session").toBe(id!);
    expect(transcriptOf(id!), "the transcript is back where --resume looks").not.toBeNull();
    expect(readFileSync(transcriptOf(id!)!, "utf8")).toBe(whole);
    expect(Date.now() - Bun.file(transcriptOf(id!)!).lastModified, "dated now, or the next CLI cleanup takes it again").toBeLessThan(120_000);

    const spawnsBefore = argvLines().length;
    await sendTurn(sk, "third");
    await waitFor("the third answer", () => assistantTexts(sk).some((t) => t.includes("remembers:2")), 45_000);
    const resumed = argvLines().slice(spawnsBefore).filter((a) => a.includes("--input-format"));
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed[0]![resumed[0]!.indexOf("--resume") + 1]).toBe(id!);
    expect(sessionRow(sk)?.claude_session_id).toBe(id!);

    // 4. The chat with no project: its transcript comes back when its turn spawns.
    expect(transcriptOf(id2!), "nothing judged it at boot").toBeNull();
    const before2 = argvLines().length;
    await sendTurn(sk2, "second");
    await waitFor("the second answer of the chat with no project", () => assistantTexts(sk2).some((t) => t.includes("remembers:1")), 45_000);
    const resumed2 = argvLines().slice(before2).filter((a) => a.includes("--input-format"));
    expect(resumed2[0]![resumed2[0]!.indexOf("--resume") + 1]).toBe(id2!);
  }, slackMs(240_000));
});
