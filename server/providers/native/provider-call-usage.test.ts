/**
 * THE NATIVE RUNTIME'S TOKENS MUST LEAVE BY THE DOOR THAT WRITES THEM ON THE ROW.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A turn's tally has TWO destinations and the native runtime served only one.
 * `recordTurnUsage` fills the in-memory registry the dispatcher polls for the
 * card's live chip; `handler.onCallUsage` is the OTHER door: the chat route
 * accumulates it, writes it onto the message row and broadcasts it to the
 * client. The native provider never called the second one - `grep -c
 * onCallUsage server/providers/native/` was 0, while claude-code calls it.
 * Measured on the live DB on 2026-08-29: 0 of 147 assistant rows in the last 24
 * hours carried a token count, and the last one that did was from 2026-08-24,
 * the day sessions moved to this runtime. The report, in the user's own words:
 * "non vedo piu' il consumo token nella chat topics". // allow-italian: quoted report
 *
 * This drives the REAL provider (`sendChat`, not the loop underneath) against a
 * fake two-round SSE stream and watches what reaches `onCallUsage`. The loop
 * already had its own test (`round-usage.test.ts`, USAGE-03) and stayed green
 * with the defect standing: the hole was not in the loop, it was in the
 * provider's wiring, which no test crossed.
 *
 * No network and no real credentials: the test's `HOME` holds a fake but fresh
 * token, which is all it takes to skip the refresh path.
 * @covers USAGE-04
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let home: string;
let workspace: string;

/** One SSE event, shaped the way the API sends it. */
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const roundWithTool = sse([
  {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_1h_input_tokens: 3 },
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"does-not-exist.txt"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
]);

const finalRound = sse([
  {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 200,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 1 },
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

type Delivered = {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  model?: string;
};

function recorder(into: Delivered[]): StreamHandler {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: () => {},
    onCallUsage: (u) => into.push(u as Delivered),
  };
}

describe("the native provider and the door that writes tokens on the row", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "native-callusage-home-"));
    workspace = mkdtempSync(join(tmpdir(), "native-callusage-ws-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    process.env.HOME = home;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    for (const d of [home, workspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("every round leaves through onCallUsage, not only through the internal registry", async () => {
    const queue = [roundWithTool, finalRound];
    globalThis.fetch = (async () => new Response(queue.shift() ?? finalRound, { status: 200 })) as unknown as typeof fetch;

    const delivered: Delivered[] = [];
    const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
    await provider.sendChat("topic:usage-probe", "read a file", recorder(delivered));

    // TWO deliveries, one per round. One would mean the tally only arrives at
    // the end, which was the defect already cured inside the loop; zero means
    // this door is not connected, which was the defect here.
    expect(delivered.length).toBe(2);
  });

  test("the delivered shape is the one the route knows how to read", async () => {
    const queue = [finalRound];
    globalThis.fetch = (async () => new Response(queue.shift() ?? finalRound, { status: 200 })) as unknown as typeof fetch;

    const delivered: Delivered[] = [];
    const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
    await provider.sendChat("topic:shape-probe", "say done", recorder(delivered));

    expect(delivered.length).toBe(1);
    const u = delivered[0];
    // The names matter as much as the numbers: the route reads `inputTokens`,
    // while the loop calls them `input`/`cacheWrite` internally. A missing
    // translation here would leave the column empty just the same, with every
    // field present under the wrong key - the defect would come back without
    // breaking anything.
    expect(u.inputTokens).toBe(200);
    expect(u.outputTokens).toBe(5);
    expect(u.cacheRead).toBe(20);
    expect(u.cacheCreation).toBe(5);
    // A DISJOINT share, not an addend: the part of `cacheCreation` written with
    // a one-hour TTL. Adding it would bill that share twice.
    expect(u.cacheCreation1h).toBe(1);
    // Without the model the route cannot pick a rate, and the turn comes out
    // with its tokens but no price.
    expect(u.model).toBe("claude-haiku-4-5-20251001");
  });
});
