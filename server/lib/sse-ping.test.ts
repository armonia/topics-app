/**
 * THE NUDGES THAT PUSH OUT THE LAST FRAMES BEFORE A SILENCE.
 * @covers CHAT-STREAM-01
 *
 * WebKit strands the tail of a burst until a later chunk reaches the page while
 * its reader waits (`createSseNudge`), so after a quiet stretch the stream says
 * a comment line, and again a little later, a few times per silence. The
 * delays here leave a wide margin to a timer that fires late on a busy runner.
 */
import { describe, expect, test } from "bun:test";
import { createSseNudge, isSseCommentOnly, SSE_NUDGE_DELAYS_MS } from "./sse-ping";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (chunk: Uint8Array) => new TextDecoder().decode(chunk);

describe("createSseNudge", () => {
  test("writes one comment line at each delay of a silence, and no more", async () => {
    const written: Uint8Array[] = [];
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => true, delaysMs: [10, 400] });
    nudge.touch();
    await sleep(150);
    expect(written).toHaveLength(1);
    await sleep(450);
    expect(written).toHaveLength(2);
    expect(written.every((c) => isSseCommentOnly(c))).toBe(true);
    expect(text(written[0]!)).toBe(": nudge\n\n");
  });

  test("a burst of writes costs no nudge while it lasts, and the series starts after the last of them", async () => {
    const written: Uint8Array[] = [];
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => true, delaysMs: [60, 400] });
    for (let i = 0; i < 5; i++) { nudge.touch(); await sleep(10); }
    expect(written).toHaveLength(0);
    await sleep(200);
    expect(written).toHaveLength(1);
    await sleep(400);
    expect(written).toHaveLength(2);
  });

  test("a write in the middle of the series starts it again, and the rest of the old one never comes", async () => {
    const written: Uint8Array[] = [];
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => true, delaysMs: [10, 400] });
    nudge.touch();
    await sleep(150);
    expect(written).toHaveLength(1);
    nudge.touch();
    await sleep(150);
    expect(written).toHaveLength(2);
    nudge.stop();
    await sleep(400);
    expect(written).toHaveLength(2);
  });

  test("stop cancels the pending nudges, and a finished stream gets none", async () => {
    const written: Uint8Array[] = [];
    let alive = true;
    const nudge = createSseNudge({ write: (c) => written.push(c), alive: () => alive, delaysMs: [10, 30] });
    nudge.touch();
    nudge.stop();
    await sleep(100);
    expect(written).toHaveLength(0);
    nudge.touch();
    alive = false;
    await sleep(100);
    expect(written).toHaveLength(0);
  });

  test("by default they come every 40 ms right after the burst, then further apart, the last within a few seconds", () => {
    const delays = SSE_NUDGE_DELAYS_MS;
    expect(delays[0]).toBeLessThanOrEqual(50);
    const gaps = delays.map((d, i) => d - (i ? delays[i - 1]! : 0));
    // Close together while a busy page may still be stranding them: the first one after it is free comes at most 40 ms later.
    expect(gaps.filter((_, i) => delays[i]! <= 400).every((g) => g <= 40)).toBe(true);
    expect(delays.filter((d) => d <= 400).length).toBeGreaterThanOrEqual(10);
    // Never closer together later on, and done in seconds: a long silence costs a few dozen bytes.
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
    expect(delays[delays.length - 1]).toBeLessThan(20_000);
    expect(delays.length).toBeLessThan(20);
  });
});
