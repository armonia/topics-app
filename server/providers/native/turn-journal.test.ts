/**
 * The journal reader of a detached native turn (lossless-restart).
 *
 * @covers CCLI-04
 */
import { describe, test, expect } from "bun:test";
import { journalReader, journalingHandler, type RoundUsage } from "./turn-journal";
import type { StreamHandler } from "../types";

function textRecorder() {
  let full = "";
  const handler: StreamHandler = {
    onTextDelta: (_d, f) => { full = f; },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: () => {},
  };
  return { handler, text: () => full };
}

describe("journal reader", () => {
  test("a character split across two chunks of the store arrives whole", () => {
    const lines: string[] = [];
    const w = journalingHandler((l) => lines.push(l));
    w.onTextDelta("è «così»", "è «così»");
    const bytes = Buffer.from(lines.join(""), "utf8");
    // Split inside the first multi-byte character, right after the text key.
    const cut = bytes.indexOf(0xc3) + 1;
    const r = textRecorder();
    const reader = journalReader(r.handler);
    reader.pushBytes(bytes.subarray(0, cut));
    reader.pushBytes(bytes.subarray(cut));
    expect(r.text()).toBe("è «così»");
  });

  test("the model written in `start` reaches the usage listener", () => {
    const seen: Array<string | null> = [];
    const reader = journalReader(null, { onUsage: (_u: RoundUsage, model) => seen.push(model) });
    const u: RoundUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    reader.push(JSON.stringify({ e: "start", v: 1, pid: 1, at: 1, model: "claude-opus-5" }) + "\n");
    reader.push(JSON.stringify({ e: "usage", u }) + "\n");
    expect(seen).toEqual(["claude-opus-5"]);
    expect(reader.state.model).toBe("claude-opus-5");
  });

  test("an effect that throws does not stop the reader", () => {
    const r = textRecorder();
    const reader = journalReader(r.handler, { onEvent: () => { throw new Error("registry down"); } });
    reader.push(JSON.stringify({ e: "text", d: "ancora" }) + "\n");
    expect(r.text()).toBe("ancora");
  });
});
