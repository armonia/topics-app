/**
 * A native turn in its own process survives the death of the server that
 * started it (lossless-restart).
 *
 * @covers CCLI-04
 *
 * Real pieces: the AI broker daemon (isolated socket and store), the real
 * `turn-host.ts` process, the real agent loop. Only the model is fake
 * (`tests/e2e/helpers/fake-anthropic-api.ts`), streaming its answer in pieces.
 * "The server dies" is the broker client going away mid-answer; the new server
 * is a fresh client that reattaches.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopOwnAiBridges } from "../../../scripts/stray-ai-bridges";
import { startFakeAnthropic, installFakeAnthropic, pieceTexts, type FakeAnthropic } from "../../../tests/e2e/helpers/fake-anthropic-api";
import type { StreamHandler } from "../types";

const SOCK = join(tmpdir(), `native-detached-${process.pid}.sock`);
const envKeys = ["TOPICS_AI_BRIDGE_SOCKET", "TOPICS_DATA_DIR", "TOPICS_AI_BRIDGE", "HOME", "TOPICS_CREDENTIALS_KEYCHAIN", "TOPICS_NATIVE_DETACHED", "ANTHROPIC_BASE_URL"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const dataDir = mkdtempSync(join(tmpdir(), "native-detached-data-"));
const home = mkdtempSync(join(tmpdir(), "native-detached-home-"));
process.env.TOPICS_AI_BRIDGE_SOCKET = SOCK;
process.env.TOPICS_DATA_DIR = dataDir;
process.env.TOPICS_AI_BRIDGE = "1";
process.env.HOME = home;
process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
delete process.env.TOPICS_NATIVE_DETACHED;
// A Claude Code shell carries its own base URL, which would beat the fake
// written in settings.json and send the fake token to the real API.
delete process.env.ANTHROPIC_BASE_URL;

const { runDetachedTurn, reattachDetachedTurn, liveDetachedSessions } = await import("./detached-turn");
const { __resetAiBridgeClientForTests } = await import("../../lib/ai-bridge-client");
import type { TurnSpec } from "./turn-host";

const PIECES = 12;
let fake: FakeAnthropic;
let undoFake: () => void;

beforeAll(async () => {
  fake = await startFakeAnthropic({
    long: [{ textPieces: PIECES, pieceMs: 150 }],
    short: [{ text: "subito" }],
  });
  undoFake = installFakeAnthropic(home, fake.baseUrl);
});

afterAll(async () => {
  __resetAiBridgeClientForTests();
  await stopOwnAiBridges();
  undoFake?.();
  await fake?.close();
  for (const d of [dataDir, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function spec(sessionKey: string, scen: string): TurnSpec {
  return {
    v: 1,
    sessionKey,
    model: "claude-sonnet-5-5",
    history: [{ role: "user", content: `SCEN:${scen}` }],
    tools: [],
    mcpTools: [],
    workspace: "",
    server: { baseUrl: "https://127.0.0.1:1" },
  };
}

function recorder() {
  const events: string[] = [];
  let text = "";
  let doneResolve!: () => void;
  const done = new Promise<void>((r) => { doneResolve = r; });
  const handler: StreamHandler = {
    onTextDelta: (d, full) => { text = full; events.push(`text:${d}`); },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { events.push("done"); doneResolve(); },
    onError: (e) => { events.push(`error:${e}`); doneResolve(); },
    onAborted: () => { events.push("aborted"); doneResolve(); },
  };
  return { handler, events, done, text: () => text };
}

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("detached native turn", () => {
  test("a whole turn: every piece, the ending, the conversation back", async () => {
    const r = recorder();
    const out = await runDetachedTurn(spec("topic:dt000001", "short"), r.handler, {});
    expect(r.events).toContain("done");
    expect(r.text()).toBe("subito");
    expect(out.end?.history.length).toBe(2);
    // The broker forgets a session whose ending a server read.
    expect((await liveDetachedSessions()).has("topic:dt000001")).toBe(false);
  }, 30_000);

  test("the server dies mid-answer: the next one finds the same turn, nothing regenerated", async () => {
    const sk = "topic:dt000002";
    const first = recorder();
    void runDetachedTurn(spec(sk, "long"), first.handler, {});
    await until(() => first.events.filter((e) => e.startsWith("text:")).length >= 4);
    // The old server goes away while the model is still writing.
    __resetAiBridgeClientForTests();
    expect(first.events).not.toContain("done");

    const second = recorder();
    const { outcome, done } = await reattachDetachedTurn(sk, second.handler);
    expect(outcome).toBe("live");
    await second.done;
    await done;
    const whole = pieceTexts(PIECES).join("");
    expect(second.text()).toBe(whole);
    expect(second.events.filter((e) => e.startsWith("text:")).map((e) => e.slice(5)).join("")).toBe(whole);
    expect(second.events.at(-1)).toBe("done");
    // One request for the one round: the turn was never started again.
    expect(fake.requests.filter((q) => q.scen === "long")).toHaveLength(1);
  }, 30_000);

  test("a turn that ended while no server listened is read from the store", async () => {
    const sk = "topic:dt000003";
    const first = recorder();
    void runDetachedTurn(spec(sk, "long"), first.handler, {});
    await until(() => first.events.some((e) => e.startsWith("text:")));
    __resetAiBridgeClientForTests();
    // Long enough for the rest of the answer and the process's exit.
    await new Promise((r) => setTimeout(r, PIECES * 150 + 1_500));
    const second = recorder();
    const { outcome } = await reattachDetachedTurn(sk, second.handler);
    expect(outcome).toBe("completed");
    expect(second.text()).toBe(pieceTexts(PIECES).join(""));
    expect(second.events.at(-1)).toBe("done");
    expect(fake.requests.filter((q) => q.scen === "long")).toHaveLength(2);
  }, 30_000);
});
