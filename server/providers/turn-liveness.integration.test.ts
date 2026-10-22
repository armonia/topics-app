/**
 * The stream feeds the turn's cap: a line arriving from the process is a sign
 * of life.
 *
 * This is the joint that had come apart. The cap in `turn-deadline.ts` measures
 * SILENCE, and has done since August, but Muse and Codex mounted it inside a
 * wrapper that returned `clear` alone: `noteActivity` never came out, so nobody
 * could say "I am working" and the thirty minutes went back to being clock
 * time. On 22/10 a session died with "Muse turn timed out after 30 minutes"
 * mid-turn. A test on the module alone cannot see this: the PROCESS is what has
 * to be watched.
 *
 * The spy is TRANSPARENT (it wraps the real implementation and counts), so even
 * if `mock.module` stays mounted for the files that follow in the same process
 * it changes nobody's behaviour.
 *
 * @covers CHAT-REL-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import type { StreamHandler } from "./types";
import type { ProviderTurnTimeoutOptions } from "../lib/turn-deadline";

// The REAL exports are captured before the swap, one by one: `mock.module`
// rewrites the already-imported NAMESPACE, so reading the function off it
// inside the spy would mean calling the spy itself (stack overflow), and a
// namespace spread makes the module opaque to `check:deadcode-blindspots`.
// The module is given back in `afterAll`: a swap lasts for the whole `bun test`
// process and `mock.restore()` does not undo it.
const { armTurnDeadline, armProviderTurnTimeout, PROVIDER_TURN_TIMEOUT_MS } = await import("../lib/turn-deadline");
const realDeadline = { armTurnDeadline, armProviderTurnTimeout, PROVIDER_TURN_TIMEOUT_MS };
let signsOfLife = 0;
mock.module("../lib/turn-deadline", () => ({
  ...realDeadline,
  armProviderTurnTimeout: (opts: ProviderTurnTimeoutOptions) => {
    const cap = armProviderTurnTimeout(opts);
    return { clear: cap.clear, noteActivity: () => { signsOfLife += 1; cap.noteActivity(); } };
  },
}));

const { MuseProvider } = await import("./muse");
const { CodexProvider } = await import("./codex");
const { _resetMuseBinCache } = await import("../lib/muse-bin");
const { _resetCodexBinCache } = await import("../lib/codex-bin");

let tempRoot: string;
const previous = {
  MUSE_BIN: process.env.MUSE_BIN, CODEX_BIN: process.env.CODEX_BIN,
  CODEX_HOME: process.env.CODEX_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "topics-turn-liveness-")));
  initDatabase(join(import.meta.dir, "..", ".."), tempRoot);
  process.env.XDG_DATA_HOME = join(tempRoot, "xdg");
  process.env.CODEX_HOME = join(tempRoot, "codex-home");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });

  const muse = join(tempRoot, "fake-muse");
  const fixture = join(import.meta.dir, "muse", "fake-muse.fixture.ts");
  writeFileSync(muse, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(muse, 0o755);
  process.env.MUSE_BIN = muse;
  _resetMuseBinCache();

  const codex = join(tempRoot, "fake-codex");
  writeFileSync(codex, `#!${process.execPath}
await Bun.stdin.text();
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-liveness" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "vivo" } }));
`, { mode: 0o700 });
  process.env.CODEX_BIN = codex;
  _resetCodexBinCache();
});

afterAll(() => {
  mock.module("../lib/turn-deadline", () => realDeadline);
  for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetMuseBinCache();
  _resetCodexBinCache();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
});

function seedTopic(sessionKey: string): void {
  getDatabase().prepare(
    "INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')",
  ).run(sessionKey, sessionKey, sessionKey, sessionKey);
}

function recorder(): { handler: StreamHandler; done: Promise<string> } {
  let close!: (r: string) => void;
  const done = new Promise<string>((r) => { close = r; });
  const handler = {
    onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
    onDone: (m: { result?: string } | undefined) => close(m?.result ?? ""),
    onError: (e: string) => close(`error:${e}`),
    onAborted: () => close("aborted"),
  } as unknown as StreamHandler;
  return { handler, done };
}

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), 15000))]);
}

describe("il tetto del turno riceve il segno di vita dal processo", () => {
  test("Muse: ogni riga dello stream rimanda indietro il tetto", async () => {
    const sessionKey = "topic:vita-muse";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    const before = signsOfLife;
    try {
      const t = recorder();
      await provider.sendChat(sessionKey, "ciao", t.handler, {});
      expect(await within(t.done, "onDone")).toContain("echo");
    } finally {
      provider.stop();
    }
    // The fixture emits seven events: if the cap does not see them it stays at
    // zero, and the thirty minutes go back to being clock time.
    expect(signsOfLife - before).toBeGreaterThanOrEqual(3);
  });

  test("Codex: ogni riga dello stream rimanda indietro il tetto", async () => {
    const sessionKey = "topic:vita-codex";
    seedTopic(sessionKey);
    const provider = new CodexProvider({ type: "codex", defaultWorkspace: tempRoot });
    const before = signsOfLife;
    const t = recorder();
    await provider.sendChat(sessionKey, "ciao", t.handler, { model: "gpt-test-fixture" });
    expect(await within(t.done, "onDone")).toContain("vivo");
    expect(signsOfLife - before).toBeGreaterThanOrEqual(2);
  });
});
