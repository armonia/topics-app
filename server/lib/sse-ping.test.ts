/**
 * THE NUDGE THAT PUSHES OUT THE LAST FRAME BEFORE A SILENCE.
 * @covers CHAT-STREAM-01
 *
 * WebKit holds the tail of a streamed response until more bytes follow
 * (`createSseNudge`), so after a quiet stretch the stream says one comment line.
 */
import { describe, expect, test } from "bun:test";
import { createSseNudge, isSseCommentOnly } from "./sse-ping";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (chunk: Uint8Array) => new TextDecoder().decode(chunk);

describe("createSseNudge", () => {
  test("writes one comment line once the stream has been quiet, and never twice for one silence", async () => {
    const written: Uint8Array[] = [];
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => true, delayMs: 15 });
    nudge.touch();
    await sleep(80);
    expect(written).toHaveLength(1);
    expect(isSseCommentOnly(written[0])).toBe(true);
    expect(text(written[0]!)).toBe(": nudge\n\n");
  });

  test("a burst of writes costs one nudge, after the last of them", async () => {
    const written: Uint8Array[] = [];
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => true, delayMs: 30 });
    for (let i = 0; i < 5; i++) { nudge.touch(); await sleep(8); }
    expect(written).toHaveLength(0);
    await sleep(80);
    expect(written).toHaveLength(1);
  });

  test("stop cancels a pending nudge, and a finished stream gets none", async () => {
    const written: Uint8Array[] = [];
    let alive = true;
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => alive, delayMs: 15 });
    nudge.touch();
    nudge.stop();
    await sleep(60);
    expect(written).toHaveLength(0);
    nudge.touch();
    alive = false;
    await sleep(60);
    expect(written).toHaveLength(0);
  });
});
