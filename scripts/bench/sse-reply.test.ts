/**
 * @covers CHAT-STREAM-01
 */
import { describe, expect, test } from "bun:test";
import { sseReplyText } from "./sse-reply";

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (c: string) => frame({ choices: [{ index: 0, delta: { content: c } }] });

describe("sseReplyText", () => {
  test("a failed turn whose row id holds 20 has no 20 in its reply", () => {
    const body = frame({ turn: { messageId: "5f3a2019-0c7e-4b20-9d11-a8c3e2f0b720" } })
      + ": ping\n\n"
      + delta("Non sono riuscito ad avviare il turno")
      + frame({ turn: { end: "error" } })
      + "data: [DONE]\n\n";
    expect(body).toContain("20");
    expect(sseReplyText(body)).toBe("Non sono riuscito ad avviare il turno");
    expect(sseReplyText(body)).not.toContain("20");
  });

  test("an answered turn's deltas join into the reply", () => {
    const body = frame({ turn: { messageId: "m1" } }) + delta("1 2 3 ") + delta("... 19 20") + "data: [DONE]\n\n";
    expect(sseReplyText(body)).toBe("1 2 3 ... 19 20");
  });
});
