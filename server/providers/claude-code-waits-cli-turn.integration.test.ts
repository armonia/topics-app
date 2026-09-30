/**
 * THE CLI'S OWN TURN, WITH A REAL CHILD: the message reaches it only after that
 * turn's result.
 *
 * The unit test (`claude-code-waits-cli-turn.test.ts`) drives the event handler
 * by hand. Here a (fake) CLI child runs in the broker, answers a first message,
 * and a moment later opens a turn by itself the way a background task's report
 * does: notification, init, three rounds of text and a Bash call, result. A
 * message sent as soon as that turn starts must not be written into it. The
 * fake writes down, for every line it reads, whether a turn was running
 * (`tests/e2e/helpers/fake-claude-queue-turns.ts`).
 *
 * @covers CHAT-QUEUE-07
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stopOwnAiBridges } from "../../scripts/stray-ai-bridges";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import type { StreamHandler } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SESSION = "topic:waits-cli-turn";
let tempDir = "";
let logPath = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "waits-cli-turn-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  logPath = join(tempDir, "fake-cli.jsonl");
  // A wrapper names the log and bun by absolute path: the CLI's environment is trimmed.
  const bun = execSync("command -v bun").toString().trim();
  const script = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-queue-turns.ts");
  const wrapper = join(tempDir, "fake-claude");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexport FAKE_CLI_LOG="${logPath}"\nexec "${bun}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", wrapper);
});

afterAll(async () => {
  await stopOwnAiBridges();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

interface LogLine { at: number; event: string; text?: string; busy?: boolean; tag?: string }
const readLog = (): LogLine[] => existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine)
  : [];

function recorder() {
  const texts: string[] = [];
  let resolveDone!: (r: string) => void;
  const done = new Promise<string>((r) => { resolveDone = r; });
  const handler: StreamHandler = {
    onTextDelta: (t: string) => { texts.push(t); },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (m) => resolveDone(m?.result ?? ""),
    onError: (e: string) => resolveDone(`error:${e}`),
    onAborted: () => resolveDone("aborted"),
  } as StreamHandler;
  return { handler, texts, done };
}

describe("a message sent while the CLI runs a turn of its own (real child, broker)", () => {
  test("is read by the CLI only after that turn's result, once", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-wct", "wct", "wct", SESSION, now, now);

    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    // The route's part, reduced: the turn the CLI opens by itself is adopted into its own handler.
    const adopter = recorder();
    ClaudeCodeProvider.observeWokenTurns((sk) => { provider.adoptWokenTurn(sk, adopter.handler); return true; });
    let cliOpened!: () => void;
    const opened = new Promise<void>((r) => { cliOpened = r; });
    let turnsSeen = 0;
    ClaudeCodeProvider.observeCliTurns((sk, open) => { if (sk === SESSION && open && ++turnsSeen === 2) cliOpened(); });

    const arm = recorder();
    void provider.sendChat(SESSION, "WAKE:300:3:400:bg", arm.handler);
    expect(await arm.done).toBe("armed");

    // The second turn the CLI opens is its own: the message is sent right then.
    await opened;
    const second = recorder();
    provider.registerStreamHandler(SESSION, undefined, second.handler);
    const sent = provider.sendChat(SESSION, "QUEUED-AFTER-END", second.handler);

    expect(await adopter.done).toContain("bg END.");
    expect(await second.done).toContain("got: QUEUED-AFTER-END");
    await sent;
    // The adopted turn's rounds went to its own handler, not to the message's.
    expect(second.texts.join("")).not.toContain("bg round");

    const log = readLog();
    const bgEnd = log.find((l) => l.event === "turn-end" && l.tag === "bg")!;
    const received = log.filter((l) => l.event === "received" && l.text?.includes("QUEUED-AFTER-END"));
    expect(received).toHaveLength(1);
    expect(received[0]!.busy).toBe(false);
    expect(received[0]!.at).toBeGreaterThanOrEqual(bgEnd.at);

    ClaudeCodeProvider.observeWokenTurns(() => false);
    ClaudeCodeProvider.observeCliTurns(() => {});
    await provider.stop();
  }, 45_000);
});
