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

const { runDetachedTurn, reattachDetachedTurn, liveDetachedSessions, awaitStrayTurn, brokerIdFor, forwardHostLog, steerDetachedTurn } = await import("./detached-turn");
const { offerSteer, openSteerTarget, setSteerSink, steerState } = await import("../../lib/turn-steer");
const { __resetAiBridgeClientForTests, getAiBridgeClient } = await import("../../lib/ai-bridge-client");
const { clearProviderHold, holdForApiDown, providerHold, setProviderHold } = await import("../../lib/provider-hold");
import type { TurnSpec } from "./turn-host";

const PIECES = 12;
let fake: FakeAnthropic;
let undoFake: () => void;

beforeAll(async () => {
  fake = await startFakeAnthropic({
    long: [{ textPieces: PIECES, pieceMs: 150 }],
    tail: [{ textPieces: PIECES, pieceMs: 150 }],
    stalehold: [{ textPieces: 6, pieceMs: 150 }],
    spawndrop: [{ textPieces: PIECES, pieceMs: 150 }],
    short: [{ text: "subito" }],
    // A round that calls a tool while its text streams, then the answer: a steered message lands between the two.
    steer: [{ textPieces: 6, pieceMs: 150, tools: [{ name: "no_such_tool", input: {} }] }, { text: "fatto" }],
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

const until = async (pred: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
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

  test("a message offered while the host runs reaches the model at its next round, and the journal writes its row", async () => {
    // @covers CHAT-QUEUE-08: the real host and broker, the wiring `driveTurn` uses (forwardTo the control channel).
    const sk = "topic:dt0000st";
    const taken: string[] = [];
    setSteerSink({ taken: (_sk, item) => { taken.push(item.text); }, returned: () => {} });
    try {
      const target = openSteerTarget(sk);
      const r = recorder();
      const turn = runDetachedTurn(spec(sk, "steer"), r.handler, {
        onStarted: () => target.forwardTo((item) => steerDetachedTurn(sk, item)),
      });
      await until(() => r.events.some((e) => e.startsWith("text:")));
      const item = offerSteer(sk, "usa la porta 2222", { key: null, dispatched: false, dispatchedFor: [], author: null, into: null })!;
      await turn;
      target.close();
      expect(r.events).toContain("done");
      expect(taken).toEqual(["usa la porta 2222"]);
      expect(steerState(sk, item.id)?.state).toBe("taken");
      // The second request carries it, after the tool result.
      const second = fake.requests.find((q) => q.scen === "steer" && q.round === 1)!;
      const last = second.messages[second.messages.length - 1]!;
      expect(JSON.stringify(last.content)).toContain("usa la porta 2222");
      expect(JSON.stringify(last.content).indexOf("tool_result")).toBeLessThan(JSON.stringify(last.content).indexOf("usa la porta 2222"));
    } finally {
      setSteerSink(null);
    }
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

  const textCount = (r: ReturnType<typeof recorder>) => r.events.filter((e) => e.startsWith("text:")).length;
  const dropSocket = () => { (getAiBridgeClient() as unknown as { socket: { destroy: () => void } | null }).socket?.destroy(); };

  test("the broker socket drops mid-answer: the turn is still heard to its end", async () => {
    const r = recorder();
    const run = runDetachedTurn(spec("topic:dt000004", "long"), r.handler, {});
    await until(() => textCount(r) >= 3);
    dropSocket();
    // Live again before the turn ends, not only through the tail read at its exit.
    await until(() => textCount(r) >= PIECES - 3);
    expect(r.events).not.toContain("done");
    const out = await run;
    expect(r.text()).toBe(pieceTexts(PIECES).join(""));
    expect(r.events.at(-1)).toBe("done");
    expect(out.end).not.toBeNull();
  }, 30_000);

  test("a Stop pressed while the socket is being re-made still stops the turn", async () => {
    const r = recorder();
    const stop = new AbortController();
    const run = runDetachedTurn(spec("topic:dt000005", "long"), r.handler, { signal: stop.signal });
    await until(() => textCount(r) >= 2);
    dropSocket();
    stop.abort("user");
    await run;
    expect(r.events).toContain("aborted");
    expect(r.events).not.toContain("done");
  }, 30_000);

  test("a host that dies without its ending is forgotten by the broker", async () => {
    const sk = "topic:dt000006";
    const r = recorder();
    const run = runDetachedTurn(spec(sk, "long"), r.handler, {});
    await until(() => textCount(r) >= 2);
    const info = (await getAiBridgeClient().list()).find((x) => x.id === brokerIdFor(sk));
    process.kill(info!.pid, "SIGKILL");
    await run;
    expect(r.events.at(-1)).toStartWith("error:");
    // A dead store left behind would be read by the boot as this session's turn.
    const left = (await getAiBridgeClient().list()).find((x) => x.id === brokerIdFor(sk));
    expect(left).toBeUndefined();
  }, 30_000);

  test("a reattach that finds nothing tells the route", async () => {
    const r = recorder();
    const { outcome } = await reattachDetachedTurn("topic:dt000007", r.handler);
    expect(outcome).toBe("dead");
    expect(r.events.some((e) => e.startsWith("error:"))).toBe(true);
  }, 30_000);

  test("a turn nobody follows is waited for and its conversation kept", async () => {
    const sk = "topic:dt000008";
    const first = recorder();
    void runDetachedTurn(spec(sk, "long"), first.handler, {});
    await until(() => textCount(first) >= 2);
    __resetAiBridgeClientForTests();
    const end = await awaitStrayTurn(sk);
    expect(end?.history.length).toBe(2);
    expect(await awaitStrayTurn(sk)).toBeNull();
  }, 30_000);

  test("an attachment lost without a socket drop: the tail is read at the host's exit", async () => {
    const sk = "topic:dt000009";
    const r = recorder();
    const run = runDetachedTurn(spec(sk, "tail"), r.handler, {});
    await until(() => textCount(r) >= 3);
    // The daemon stops sending to us; only the exit frame still names the turn.
    getAiBridgeClient().detach(brokerIdFor(sk));
    const out = await run;
    expect(r.text()).toBe(pieceTexts(PIECES).join(""));
    expect(r.events.at(-1)).toBe("done");
    expect(out.end).not.toBeNull();
  }, 30_000);

  test("a socket drop during the spawn is not a dead turn, even if another caller reconnects first", async () => {
    const sk = "topic:dt000010";
    const r = recorder();
    const c = getAiBridgeClient() as unknown as { send: (m: { type?: string; id?: string }) => boolean; socket: { destroy: () => void } | null; list: () => Promise<unknown> };
    await getAiBridgeClient().ensureConnected();
    const origSend = c.send.bind(c);
    let dropped = false;
    c.send = (msg) => {
      if (!dropped && msg?.type === "spawn" && msg.id === brokerIdFor(sk)) {
        dropped = true;
        c.socket?.destroy();
        // Another user of the shared client reconnects before the spawn's retry.
        setTimeout(() => { void c.list().catch(() => {}); }, 30);
        return false;
      }
      return origSend(msg);
    };
    try {
      await runDetachedTurn(spec(sk, "spawndrop"), r.handler, {});
    } finally {
      c.send = origSend;
    }
    expect(r.events.filter((e) => e.startsWith("error:"))).toEqual([]);
    expect(r.events.at(-1)).toBe("done");
    expect(r.text()).toBe(pieceTexts(PIECES).join(""));
  }, 30_000);

  test("a journal with multi-byte text cut across the broker's chunks is read without U+FFFD", async () => {
    const sk = "topic:dt000011";
    const piece = "è«»€😀".repeat(15_000);
    // A stand-in host: big lines of 2, 3 and 4-byte characters, so the
    // chunks the broker forwards end inside a character.
    const host = `
      const { writeSync } = require("node:fs");
      const w = (o) => { const b = Buffer.from(JSON.stringify(o) + "\\n"); let off = 0; while (off < b.length) off += writeSync(1, b, off); };
      const piece = ${JSON.stringify("è«»€😀")}.repeat(15000);
      w({ e: "start", v: 1, pid: process.pid, at: Date.now(), model: "m" });
      w({ e: "req", at: Date.now() });
      for (let i = 0; i < 6; i++) { w({ e: "text", d: piece }); await new Promise((r) => setTimeout(r, 40)); }
      w({ e: "done", m: {} });
      w({ e: "end", history: [{ role: "assistant", content: piece.repeat(6) }] });
    `;
    const client = getAiBridgeClient();
    await client.ensureConnected();
    await client.spawn(brokerIdFor(sk), { cliPath: process.execPath, args: ["-e", host], cwd: "/", env: { PATH: process.env.PATH ?? "" } });
    // Followed live: the pipe hands the broker 64 KB chunks, cut anywhere.
    const r = recorder();
    const { done } = await reattachDetachedTurn(sk, r.handler);
    const out = await done;
    expect(r.text()).toBe(piece.repeat(6));
    expect(JSON.stringify(out.end?.history)).not.toContain("\uFFFD");
    expect((out.end?.history[0] as { content: string }).content).toBe(piece.repeat(6));
  }, 30_000);

  test("an answered round in the host lifts the server's outage hold, never a plan hold set meanwhile", async () => {
    clearProviderHold();
    try {
      holdForApiDown();
      const plain = recorder();
      await runDetachedTurn({ ...spec("topic:dt000012", "short"), hold: providerHold() }, plain.handler, {});
      expect(providerHold()).toBeNull();

      holdForApiDown();
      const r = recorder();
      let set = false;
      const planUntil = Date.now() + 3 * 3_600_000;
      const inner = r.handler.onTextDelta;
      r.handler.onTextDelta = (d, full) => {
        inner(d, full);
        // The plan window runs out on the server while the host still holds its api-down seed.
        if (!set) { set = true; setProviderHold({ untilMs: planUntil, window: "five_hour", reason: "spent" }); }
      };
      await runDetachedTurn({ ...spec("topic:dt000013", "stalehold"), hold: providerHold() }, r.handler, {});
      expect(r.events.at(-1)).toBe("done");
      expect(providerHold()?.window).toBe("five_hour");
    } finally {
      clearProviderHold();
    }
  }, 30_000);

  test("the host's stdout holds only journal lines; its round lines reach the server's stdout log", async () => {
    const host = Bun.spawn([process.execPath, join(import.meta.dir, "turn-host.ts")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string>,
    });
    host.stdin.write(JSON.stringify(spec("topic:dt000014", "short")) + "\n");
    await host.stdin.flush();
    const [out, err] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()]);
    await host.exited;
    const lines = out.split("\n").filter((l) => l.trim());
    const notJson = lines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
    expect(notJson).toEqual([]);
    expect(err).toContain("[native] round:");

    const toStdout: string[] = [];
    const toStderr: string[] = [];
    const forward = forwardHostLog("native:topic:x", { out: (l) => toStdout.push(l), err: (l) => toStderr.push(l) });
    const round = err.split("\n").find((l) => l.startsWith("[native] round:"))!;
    const bytes = Buffer.from(`[turn-host 1] start\n${round}\n`);
    // Two lines in one chunk, the second cut across two chunks.
    forward(bytes.subarray(0, bytes.length - 10));
    forward(bytes.subarray(bytes.length - 10));
    expect(toStdout).toEqual([`[native-detached] native:topic:x: ${round}`]);
    expect(toStderr).toEqual(["[native-detached] native:topic:x: [turn-host 1] start"]);
  }, 30_000);
});
