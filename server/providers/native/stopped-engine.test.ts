/**
 * A STOPPED ENGINE STARTS NO TURN.
 *
 * The chat route opens the stream, awaits its own work (the `memrecall` run,
 * about 35 ms on a Mac that has it), and only then calls `sendChat`. A `stop()`
 * that lands in that gap (the Topics engine removed from Settings, the provider
 * replaced) finds no session to abort, and the turn then ran to its end on an
 * instance the registry no longer has: a child's turn reported `end_turn` for an
 * engine that was gone, instead of `failed` (08/10, subagent-native-review6 red on
 * every Mac with memrecall, green in CI where nothing waits in that gap).
 *
 * Here the gap is made exact: the provider is stopped, then the turn arrives.
 * Red against the code before the guard: the request leaves and the turn ends
 * `done`.
 *
 * @covers RT-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let home: string;
let workspace: string;

const finalRound = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "an answer from a removed engine" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

describe("a turn that reaches a stopped engine", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "native-stopped-home-"));
    workspace = mkdtempSync(join(tmpdir(), "native-stopped-ws-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = home;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    for (const d of [home, workspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("ends at once with the cause of a shutdown, and sends nothing to the model", async () => {
    const SK = "topic:stopped-engine";
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response(finalRound, { status: 200 }); }) as unknown as typeof fetch;
    const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
    provider.stop();

    const events: string[] = [];
    const ends: TurnEndInfo[] = [];
    const handler: StreamHandler = {
      onTextDelta: () => { events.push("text"); },
      onToolStart: () => {},
      onToolResult: () => {},
      onDone: (m) => { events.push("done"); if (m?.turnEnd) ends.push(m.turnEnd); },
      onError: () => { events.push("error"); },
      onAborted: (m) => { events.push("aborted"); if (m?.turnEnd) ends.push(m.turnEnd); },
    };
    const result = await provider.sendChat(SK, "go", handler);

    expect(requests, "no request leaves a stopped engine").toBe(0);
    expect(events, "the turn ends once, as cut, never as done").toEqual(["aborted"]);
    expect(ends[0]).toMatchObject({ end: "cancelled", cause: "server-shutdown" });
    expect(result.notSent, "the route is told nothing was written").toBe(true);
    expect(provider.isTurnProcessAlive(SK)).toBe(false);
  });
});
