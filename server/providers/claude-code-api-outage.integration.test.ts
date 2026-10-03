/**
 * A TURN CUT DURING AN API BLACKOUT SAYS SO, AND THE BLACKOUT HOLDS THE RESUME.
 *
 * Topic 3019832f, 25/09 (card e30f35e4). The last tool_result at 02:00:44Z,
 * then the API stopped answering: the CLI printed `system/api_retry` on stdout
 * at 02:06, 02:12, 02:18, 02:24 and 02:30 ("Request timed out", attempts 1-5
 * of 10). Topics read every `system/*` line as noise, so the send watchdog saw
 * 30 minutes of silence («ultimo evento: user»), killed a child that was  allow-italian: quoted log line
 * retrying, and closed the turn with a bare text and no cause. No sweep ever
 * read that row as a cut: 52 minutes stopped, until a person resent by hand.
 *
 * Real broker, fake CLI (a shell script, below): a tool round, then retries.
 * @covers RESUME-04
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { slackMs } from "../../tests/helpers/time-slack";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
let sock = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The watchdog's window, widened with the load: a CLI that spawns late, or a
 *  gap between two retries longer than the window, is the machine, not a cut. */
const WINDOW_MS = slackMs(1_000);
/** Retries every 250 ms for two and a half windows. */
const RETRIES = Math.ceil((WINDOW_MS * 2.5) / 250);

const SID = '"session_id":"00000000-0000-4000-8000-00000000a0a0"';
const RETRY = `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"unknown",${SID}}`;

/**
 * One stdin line per message. "outage": a tool round, one retry, then nothing
 * (the request hangs). "retrying": the same round, then a retry every 250 ms
 * for 2.5 watchdog windows, then nothing. Anything else: an answer streamed from the API
 * (`message_start` first, as `--include-partial-messages` delivers it).
 */
function writeFakeCli(): string {
  const p = join(tempDir, "fake-claude-api-outage.sh");
  const round = [
    `{"type":"system","subtype":"init",${SID},"model":"claude-finto","tools":[]}`,
    `{"type":"assistant",${SID},"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}`,
    `{"type":"user",${SID},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}`,
  ].map((l) => `  echo '${l}'`).join("\n");
  writeFileSync(p, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *outage*)
${round}
      echo '${RETRY}'
      ;;
    *retrying*)
${round}
      i=0
      while [ $i -lt ${RETRIES} ]; do sleep 0.25; echo '${RETRY}'; i=$((i+1)); done
      ;;
    *)
      echo '{"type":"system","subtype":"init",${SID},"model":"claude-finto","tools":[]}'
      echo '{"type":"stream_event",${SID},"event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}}'
      echo '{"type":"assistant",${SID},"message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}'
      echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"pong",${SID},"duration_ms":2,"total_cost_usd":0}'
      ;;
  esac
done
`);
  chmodSync(p, 0o755);
  return p;
}

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "api-outage-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  sock = join(tempDir, "ai-bridge.sock");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", sock);
  setEnv("TOPICS_CLAUDE_CLI_PATH", writeFakeCli());
  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT);
  const now = new Date().toISOString();
  const insert = getDatabase().prepare(
    `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const k of ["outage", "expired", "retrying", "answer", "retry-shown"]) insert.run(`t-api-${k}`, `api-${k}`, `api-${k}`, `topic:api-${k}`, now, now);
});

afterEach(async () => {
  const { clearProviderHold } = await import("../lib/provider-hold");
  clearProviderHold();
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  try {
    const pidPath = sock.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* already gone */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

/** The ends a handler received, tagged with their cause. */
function ends() {
  const log: string[] = [];
  const handler = {
    onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
    onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
    onAborted: (m?: { turnEnd?: { cause?: string } }) => log.push(`aborted:${m?.turnEnd?.cause ?? ""}`),
    onDone: (m?: { result?: string }) => log.push(`done:${m?.result ?? ""}`),
    onError: (e: string) => log.push(`error:${e}`),
  };
  return { log, handler };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) return false;
    await sleep(10);
  }
  return true;
}

describe("a turn cut while the CLI was retrying the API", () => {
  test("ends as `api-unavailable`, and the retry opened the api-down hold", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { providerHold } = await import("../lib/provider-hold");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    (provider as any).turnWatchdogMs = WINDOW_MS;
    const { log, handler } = ends();
    try {
      void provider.sendChat("topic:api-outage", "outage", handler as never);
      expect(await waitFor(() => log.length > 0, slackMs(8_000))).toBe(true);
      expect(log).toEqual(["aborted:api-unavailable"]);
      expect(providerHold()?.window).toBe("api-down");
    } finally {
      provider.stop();
    }
  }, 30_000);

  test("the watchdog's cut opens the hold again: the retry's own ran out twenty minutes before", async () => {
    // In production the watchdog bites thirty minutes after the last retry, and
    // that retry held for ten: the cut's `api-unavailable` held nothing, and
    // the next sweep resent into the API it had just called down.
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { clearProviderHold, providerHold } = await import("../lib/provider-hold");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    (provider as any).turnWatchdogMs = WINDOW_MS;
    const { log, handler } = ends();
    try {
      void provider.sendChat("topic:api-expired", "outage", handler as never);
      expect(await waitFor(() => providerHold()?.window === "api-down", slackMs(8_000))).toBe(true);
      clearProviderHold(); // the retry's hold, run out
      expect(await waitFor(() => log.length > 0, slackMs(8_000))).toBe(true);
      expect(log).toEqual(["aborted:api-unavailable"]);
      expect(providerHold()?.window).toBe("api-down");
    } finally {
      provider.stop();
    }
  }, 30_000);

  // 03/10, topic:d740f8ae: sei minuti di retry della CLI e in chat solo la
  // clessidra; il secondo «ci sei?» ha annullato il turno muto.
  test("the CLI's api_retry reaches the turn as onRetry, so the chat can say why it is still", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    (provider as any).turnWatchdogMs = WINDOW_MS;
    const { handler } = ends();
    const retries: Array<{ attempt: number; maxAttempts: number; delayMs: number; reason: string }> = [];
    (handler as any).onRetry = (info: (typeof retries)[number]) => retries.push(info);
    try {
      void provider.sendChat("topic:api-retry-shown", "outage", handler as never);
      expect(await waitFor(() => retries.length > 0, slackMs(8_000))).toBe(true);
      expect(retries[0]).toEqual({ attempt: 1, maxAttempts: 10, delayMs: 500, reason: "API unknown" });
    } finally {
      provider.stop();
    }
  }, 30_000);

  test("a CLI still retrying is not killed: the retries are the child working", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    (provider as any).turnWatchdogMs = WINDOW_MS;
    const { log, handler } = ends();
    try {
      const sentAt = Date.now();
      void provider.sendChat("topic:api-retrying", "retrying", handler as never);
      // Retries every 250 ms for two and a half windows: two have passed.
      await sleep(Math.max(0, sentAt + 2 * WINDOW_MS - Date.now()));
      expect(log).toEqual([]);
      // Then the CLI falls silent, and the window bites from its last retry.
      expect(await waitFor(() => log.length > 0, slackMs(8_000))).toBe(true);
      expect(log).toEqual(["aborted:api-unavailable"]);
    } finally {
      provider.stop();
    }
  }, 30_000);

  test("an answer from the API, on any chat, lifts the hold", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { holdForApiDown, providerHold } = await import("../lib/provider-hold");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    const { log, handler } = ends();
    try {
      holdForApiDown();
      await provider.sendChat("topic:api-answer", "ciao", handler as never);
      expect(log).toEqual(["done:pong"]);
      expect(providerHold()).toBeNull();
    } finally {
      provider.stop();
    }
  }, 30_000);
});
