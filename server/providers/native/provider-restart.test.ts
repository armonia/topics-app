/**
 * The native provider across a server restart (lossless-restart review,
 * findings 6, 10 and 11): what a turn left running did reaches the next turn
 * and is priced; a turn found again is priced with its own model and keeps
 * its cache warm; an old dead store is never taken for the open row's turn.
 *
 * @covers CCLI-04
 *
 * Real pieces: the AI broker daemon (isolated socket and store), the real
 * `turn-host.ts`, two `NativeProvider`s (the server before and after the
 * restart). Only the model is fake.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopOwnAiBridges } from "../../../scripts/stray-ai-bridges";
import { startFakeAnthropic, installFakeAnthropic, type FakeAnthropic } from "../../../tests/e2e/helpers/fake-anthropic-api";
import type { StreamHandler } from "../types";

const SOCK = join(tmpdir(), `native-restart-${process.pid}.sock`);
const envKeys = ["TOPICS_AI_BRIDGE_SOCKET", "TOPICS_DATA_DIR", "TOPICS_AI_BRIDGE", "HOME", "TOPICS_CREDENTIALS_KEYCHAIN", "TOPICS_NATIVE_DETACHED", "ANTHROPIC_BASE_URL"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const dataDir = mkdtempSync(join(tmpdir(), "native-restart-data-"));
const home = mkdtempSync(join(tmpdir(), "native-restart-home-"));
const ws = mkdtempSync(join(tmpdir(), "native-restart-ws-"));
const MARK = "WORK-DONE-AFTER-THE-RESTART";
writeFileSync(join(ws, "marker.txt"), MARK + "\n");
process.env.TOPICS_AI_BRIDGE_SOCKET = SOCK;
process.env.TOPICS_DATA_DIR = dataDir;
process.env.TOPICS_AI_BRIDGE = "1";
process.env.HOME = home;
process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
delete process.env.TOPICS_NATIVE_DETACHED;
delete process.env.ANTHROPIC_BASE_URL;

const { __resetAiBridgeClientForTests, getAiBridgeClient } = await import("../../lib/ai-bridge-client");
const { NativeProvider, DEFAULT_MODEL } = await import("./provider");
const { brokerIdFor, runDetachedTurn } = await import("./detached-turn");
const { readNativeUsage, resetNativeUsage } = await import("../native-usage-registry");
const { apiCallCostUsd } = await import("../../usage/pricing");
const { initDatabase } = await import("../../db");
import type { TurnSpec } from "./turn-host";

let fake: FakeAnthropic;
let undoFake: () => void;
const work = (pieces: number) => [
  { text: "step one", tools: [{ name: "read_file", input: { path: "marker.txt" } }] },
  { textPieces: pieces, pieceMs: 150 },
];

beforeAll(async () => {
  fake = await startFakeAnthropic({
    "work-stop": work(60),
    "work-dead": work(4),
    "work-usage": work(4),
    "next-stop": [{ text: "ok" }],
    "next-dead": [{ text: "ok" }],
    "next-usage": [{ text: "ok" }],
    long: [{ textPieces: 10, pieceMs: 150 }],
  });
  undoFake = installFakeAnthropic(home, fake.baseUrl);
});

afterAll(async () => {
  __resetAiBridgeClientForTests();
  await stopOwnAiBridges();
  undoFake?.();
  await fake?.close();
  for (const d of [dataDir, home, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function recorder() {
  const events: string[] = [];
  const models: Array<string | undefined> = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const handler: StreamHandler = {
    onTextDelta: (d) => { events.push(`text:${d}`); },
    onToolStart: () => { events.push("tool"); },
    onToolResult: () => {},
    onDone: () => { events.push("done"); resolve(); },
    onError: (e) => { events.push(`error:${e}`); resolve(); },
    onAborted: () => { events.push("aborted"); resolve(); },
    onCallUsage: (u) => { models.push(u.model); },
  };
  return { handler, events, models, done };
}

const until = async (pred: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const cfg = () => ({ type: "native" as const, defaultWorkspace: ws, model: "claude-sonnet-5-5" });

/** The first server starts the turn and goes away once its tool has run: the turn goes on, unfollowed. */
async function leaveTurnRunning(sk: string, scen: string): Promise<void> {
  const before = new NativeProvider(cfg());
  const r = recorder();
  void before.sendChat(sk, `SCEN:${scen}`, r.handler);
  await until(() => r.events.includes("tool"));
  before.stop();
  __resetAiBridgeClientForTests();
}

const brokerSession = async (sk: string) => (await getAiBridgeClient().list()).find((x) => x.id === brokerIdFor(sk));
const nextRequestCarriesWork = (scen: string) => {
  const q = fake.requests.filter((x) => x.scen === scen);
  expect(q).toHaveLength(1);
  return JSON.stringify(q[0]!.messages).includes(MARK);
};

describe("a turn left running by the server before", () => {
  test("a Stop while waiting for it still keeps what it did, and the restart gate does not count it as detached", async () => {
    const sk = "topic:pr000001";
    await leaveTurnRunning(sk, "work-stop");
    const after = new NativeProvider(cfg());
    const first = recorder();
    const sent = after.sendChat(sk, "SCEN:next-stop", first.handler);
    await until(() => after.isTurnProcessAlive(sk));
    // The person's message lives only in this process while the old turn is awaited.
    expect(after.turnRunsDetached(sk)).toBe(false);
    await after.abort(sk, undefined, "user");
    await sent;
    await until(async () => !(await brokerSession(sk)));
    const second = recorder();
    await after.sendChat(sk, "SCEN:next-stop", second.handler);
    await second.done;
    expect(nextRequestCarriesWork("next-stop")).toBe(true);
    after.stop();
  }, 60_000);

  test("one that already ended with nobody following is adopted, not truncated by the next spawn", async () => {
    const sk = "topic:pr000002";
    await leaveTurnRunning(sk, "work-dead");
    await until(async () => (await brokerSession(sk))?.alive === false);
    const after = new NativeProvider(cfg());
    const r = recorder();
    await after.sendChat(sk, "SCEN:next-dead", r.handler);
    await r.done;
    expect(nextRequestCarriesWork("next-dead")).toBe(true);
    after.stop();
  }, 60_000);

  test("its rounds after the restart are priced", async () => {
    const sk = "topic:pr000003";
    await leaveTurnRunning(sk, "work-usage");
    // The registry lives in the server's memory: the new server starts empty
    // and learns the old turn's rounds from its journal.
    resetNativeUsage();
    const after = new NativeProvider(cfg());
    const r = recorder();
    await after.sendChat(sk, "SCEN:next-usage", r.handler);
    await r.done;
    // Every round billed once: the old turn's (before and after the restart) and the new one's.
    const rounds = fake.requests.filter((q) => q.scen === "work-usage" || q.scen === "next-usage").length;
    expect(rounds).toBe(3);
    expect(readNativeUsage(sk)?.inputTokens).toBe(10 * rounds);
    after.stop();
  }, 60_000);
});

describe("a turn found again by reattach", () => {
  const MODEL = "claude-opus-5-5";
  const warmCalls: Array<{ sk: string; model: string; system: string }> = [];
  const proto = NativeProvider.prototype as unknown as { keepCacheWarm: (sk: string, s: unknown, opts: { model: string; system: string }, at: number) => void };
  const origWarm = proto.keepCacheWarm;
  proto.keepCacheWarm = function (this: unknown, sk, s, opts, at) {
    warmCalls.push({ sk, model: opts.model, system: opts.system });
    return origWarm.call(this, sk, s, opts, at);
  };

  test("is priced with its own model and keeps its cache warm", async () => {
    expect(DEFAULT_MODEL).not.toBe(MODEL);
    const sk = "topic:pr000004";
    const spec = {
      v: 1, sessionKey: sk, model: MODEL, effort: null, maxTokens: 4096, system: "SYS",
      history: [{ role: "user", content: "SCEN:long" }], tools: [], mcpTools: [], workspace: "",
      server: { baseUrl: "https://127.0.0.1:1" },
    } as unknown as TurnSpec;
    const first = recorder();
    void runDetachedTurn(spec, first.handler, {});
    await until(() => first.events.filter((e) => e.startsWith("text:")).length >= 2);
    __resetAiBridgeClientForTests();
    const after = new NativeProvider({ type: "native" });
    const r = recorder();
    expect(await after.reattach(sk, r.handler)).toBe("live");
    await r.done;
    await until(() => warmCalls.some((c) => c.sk === sk), 5_000);
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.models.every((m) => m === MODEL)).toBe(true);
    const expected = apiCallCostUsd(MODEL, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    expect(readNativeUsage(sk)?.costUsd).toBeCloseTo(expected!, 12);
    expect(warmCalls.find((c) => c.sk === sk)).toMatchObject({ model: MODEL, system: "SYS" });
    after.stop();
  }, 30_000);
});

describe("hasLiveSession: a dead store older than the open row is not its turn", () => {
  test("only a store at least as new as the open row is claimed", async () => {
    const db = initDatabase(process.cwd(), dataDir);
    const sk = "topic:pr000005";
    const id = brokerIdFor(sk);
    const client = getAiBridgeClient();
    await client.ensureConnected();
    await client.spawn(id, { cliPath: process.execPath, args: ["-e", "console.log('{\"e\":\"start\"}')"], cwd: "/", env: { PATH: process.env.PATH ?? "" } });
    await until(async () => (await brokerSession(sk))?.alive === false);
    const createdAt = (await brokerSession(sk))!.createdAt!;
    const provider = new NativeProvider({ type: "native" });
    const row = (ts: number) => db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, partial) VALUES (?, ?, 'assistant', '', ?, 1, 1)",
      [crypto.randomUUID(), sk, new Date(ts).toISOString()],
    );
    row(createdAt + 60_000);
    expect(await provider.hasLiveSession(sk)).toBe(false);
    db.run("DELETE FROM messages WHERE session_key = ?", [sk]);
    row(createdAt - 60_000);
    expect(await provider.hasLiveSession(sk)).toBe(true);
    client.kill(id);
    provider.stop();
  }, 30_000);
});
