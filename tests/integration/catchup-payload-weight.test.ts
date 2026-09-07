/**
 * How much OPENING A SOCKET weighs while turns are in flight.
 *
 * Companion to `history-payload-weight.test.ts`, which measures opening a
 * CHAT. The subject here is the other door onto the same data: the WS open
 * handler replays every active stream to the newcomer (`stream:catchup`), and
 * that replay is paid on every browser refresh, every second window, every
 * network reconnect and every pane that mounts, whether or not anybody is
 * looking at that chat.
 *
 * Two things are measured:
 *
 *  1. INVARIANT: the tool calls of the in-flight turn travel ONCE. They live
 *     in `blocks`, and `rowToMessage` (server/utils.ts) rebuilds the legacy
 *     `toolCalls` bucket out of those same blocks when the column is empty, so
 *     a frame that ships both ships every tool call twice. Structural: it does
 *     not depend on the machine and it goes red the moment somebody puts the
 *     bucket back.
 *
 *  2. STRIP, ONLY ON WHAT IS OVER: a tool call in `success` / `error` travels
 *     with its large text blanked and `detailBytes` / `argsBytes` declaring
 *     what was removed, exactly as history does. A RUNNING one travels whole,
 *     because that output is the thing being watched: `ToolCallRow.tsx` fetches
 *     the DB snapshot when `detailBytes > 0` and would overlay the live detail
 *     with it. This is the half that cannot be replaced by a byte budget: a
 *     blanket strip would also pass a size gate, and would blank the row the
 *     reader has their eyes on.
 *
 * The last test is the gate in the mirror: it builds the same frame the way
 * the handler built it before (the whole partial message, bucket included) and
 * demands the invariant reject it. A condition never seen to fail is not a
 * gate. Measured with this fixture: 93,050 B in the old shape against 14,445 B,
 * and on a live instance with 4 turns in flight the catchup was 2,828,244 B in
 * total (audit of 2026-09-07).
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { buildStreamCatchupFrame, type CatchupStreamState } from "../../server/lib/stream-catchup-frame";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("catchup-weight-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

/** A tool output as big as the real ones: the measured median is ~4 KB. */
function fakeOutput(seed: string, kb: number): string {
  const line = `${seed} :: the line of a tool output, as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/**
 * A tool call as the provider writes it: the text in `detail`, and `args`
 * carrying the same script the detail already types.
 */
function toolCall(id: string, status: ToolCall["status"], kb: number): ToolCall {
  const output = fakeOutput(id, kb);
  const command = `bash -lc ${JSON.stringify(fakeOutput(`${id}-cmd`, 1))}`;
  return {
    id,
    name: "Bash",
    args: { command },
    status,
    ...(status === "success" ? { result: output } : {}),
    detail: { type: "shell", command, output },
    startedAt: 1,
    ...(status === "success" ? { endedAt: 2 } : {}),
  } as ToolCall;
}

/** How many tools a turn in flight already has behind it, and how big each is. */
const FINISHED_TOOLS = 6;
const TOOL_KB = 4;
const RUNNING_ID = "tc-running";

/** The partial row of a turn in flight: N tools already over, one still writing. */
function seedPartialTurn(ctx: AppContext, sessionKey: string): StoredMessage {
  const prefix = sessionKey.replace(/[^a-z0-9]/gi, "");
  const calls: ToolCall[] = [];
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < FINISHED_TOOLS; i++) {
    const tc = toolCall(`${prefix}-${i}`, "success", TOOL_KB);
    calls.push(tc);
    blocks.push({ kind: "tool", toolCall: tc } as ContentBlock);
  }
  const running = toolCall(RUNNING_ID, "running", TOOL_KB);
  calls.push(running);
  blocks.push({ kind: "tool", toolCall: running } as ContentBlock);
  blocks.push({ kind: "text", text: "half of an answer" } as ContentBlock);
  ctx.saveLocalMessages(sessionKey, [
    { id: `${prefix}-u`, role: "user", content: "question", timestamp: new Date(1).toISOString() },
    {
      id: `${prefix}-a`, role: "assistant", content: "half of an answer",
      timestamp: new Date(2).toISOString(), parentId: `${prefix}-u`,
      blocks, toolCalls: calls, partial: true,
    },
  ]);
  return ctx.getMessageById(`${prefix}-a`)!;
}

const STREAM: CatchupStreamState = {
  messageId: "irrelevant, the frame carries it verbatim",
  content: "half of an answer",
  thinking: "",
  isThinking: false,
};

/** The frame as the WS open handler built it before this gate: the row, whole. */
function naiveFrame(partial: StoredMessage): Record<string, unknown> {
  return {
    type: "stream:catchup", sessionKey: "topic:x", topicId: "x",
    messageId: STREAM.messageId, content: STREAM.content, thinking: STREAM.thinking,
    isThinking: STREAM.isThinking, toolCalls: partial.toolCalls, blocks: partial.blocks,
  };
}

/** Every tool call the frame puts on the wire, wherever it sits. */
function frameToolCalls(frame: Record<string, unknown>): ToolCall[] {
  const out: ToolCall[] = [];
  for (const b of (frame.blocks ?? []) as Array<{ toolCall?: ToolCall }>) if (b.toolCall) out.push(b.toolCall);
  for (const tc of (frame.toolCalls ?? []) as ToolCall[]) out.push(tc);
  return out;
}

/** What the socket actually writes: `JSON.stringify` drops the `undefined` keys. */
function wireBytes(frame: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

async function catchupFrame(sessionKey: string): Promise<{ frame: Record<string, unknown>; partial: StoredMessage }> {
  const ctx = await createTestAppContext();
  const partial = seedPartialTurn(ctx, sessionKey);
  // Precondition, not decoration: without the doubled bucket the invariant
  // below would pass for the wrong reason. This is `rowToMessage` handing the
  // blocks back a second time, which is the shape the handler receives.
  expect(partial.toolCalls?.length).toBe(FINISHED_TOOLS + 1);
  expect(partial.blocks?.length).toBe(FINISHED_TOOLS + 2);
  const frame = buildStreamCatchupFrame({ sessionKey, topicId: "t", stream: STREAM, partial });
  return { frame, partial };
}

describe("il catch-up di uno stream attivo non ripete i tool e non tocca quello vivo", () => {
  test("nessun bucket `toolCalls` accanto ai blocchi: ogni tool call viaggia una volta sola", async () => {
    const { frame } = await catchupFrame("topic:catchup-once");
    expect(frame.toolCalls).toBeUndefined();
    expect(JSON.parse(JSON.stringify(frame))).not.toHaveProperty("toolCalls");
    const ids = frameToolCalls(frame).map((tc) => tc.id);
    expect(ids.length).toBe(FINISHED_TOOLS + 1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("i tool chiusi viaggiano svuotati, quello in corso intero", async () => {
    const { frame } = await catchupFrame("topic:catchup-strip");
    const calls = frameToolCalls(frame);
    const running = calls.find((tc) => tc.id === RUNNING_ID)!;
    const finished = calls.filter((tc) => tc.id !== RUNNING_ID);
    expect(finished.length).toBe(FINISHED_TOOLS);

    for (const tc of finished) {
      const detail = tc.detail as { output?: string; command?: string };
      expect(detail.output).toBe("");
      expect(tc.detailBytes).toBeGreaterThan(0);
      expect(tc.argsBytes).toBeGreaterThan(0);
      expect((tc.args.command as string).length).toBeLessThan(1024);
    }

    // The running one is what the reader is looking at: whole detail, whole
    // args, and no `detailBytes` — the counter is what makes `ToolCallRow`
    // fetch the DB snapshot and paint it over the live output.
    const liveDetail = running.detail as { output: string };
    expect(liveDetail.output.length).toBeGreaterThan(TOOL_KB * 1000);
    expect((running.args.command as string).length).toBeGreaterThan(1024);
    expect(running.detailBytes).toBeUndefined();
    expect(running.argsBytes).toBeUndefined();
  });

  test("un turno in volo sta in 75 KB, cioè quattro stanno nei 300 KB del budget", async () => {
    const { frame, partial } = await catchupFrame("topic:catchup-weight");
    const lean = wireBytes(frame);
    const naive = wireBytes(naiveFrame(partial));
    expect(lean).toBeLessThan(75 * 1024);
    expect(lean).toBeLessThan(naive * 0.2);
  });

  test("lo stesso frame com'era prima FALLISCE le due invarianti", async () => {
    const ctx = await createTestAppContext();
    const partial = seedPartialTurn(ctx, "topic:catchup-mirror");
    const before = naiveFrame(partial);
    const ids = frameToolCalls(before).map((tc) => tc.id);
    // Every tool call twice, and every closed one with its text still on it.
    expect(new Set(ids).size).toBe(ids.length / 2);
    expect(frameToolCalls(before).every((tc) => tc.detailBytes === undefined)).toBe(true);
    expect(wireBytes(before)).toBeGreaterThan(75 * 1024);
  });
});
