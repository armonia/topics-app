/**
 * The fillers in the voice of the calls, ported from `load_fillers` in jarvis-channels `service.rs`.
 * @covers CALL-04
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILLER_LINES, loadFillers, makeFillers, trimSilence } from "./fillers";
import { i16ToLe } from "./audio/pcm";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "voice-fillers-"));
  dirs.push(d);
  return d;
};
const loud = (n: number) => new Int16Array(n).fill(3000);

describe("fillers", () => {
  test("silence is trimmed around the voice, keeping a breath on both sides", () => {
    const pcm = new Int16Array(10_000);
    pcm.set(loud(1000), 4000);
    const t = trimSilence(pcm);
    // 480 samples before the first loud one, up to 1600 past the last (the Rust bound, exclusive)
    expect(t.length).toBe(480 + 1000 + 1599);
    expect(trimSilence(new Int16Array(500)).length).toBe(0);
  });

  test("the missing lines are made, the existing ones kept, a long one dropped", async () => {
    const d = scratch();
    writeFileSync(join(d, "0.pcm"), i16ToLe(new Int16Array(4000).fill(7)));
    const asked: string[] = [];
    await makeFillers(d, async (line) => {
      asked.push(line);
      // 24 kHz: "Allora..." comes out too long (3 s at 16 kHz), the others 0.5 s
      return line === FILLER_LINES[1] ? loud(72_000) : loud(12_000);
    });
    expect(asked).toEqual(FILLER_LINES.slice(1));
    expect(existsSync(join(d, "1.pcm"))).toBe(false);
    const have = loadFillers(d, null);
    expect(have.length).toBe(FILLER_LINES.length - 1);
    expect(have[0]![0]).toBe(7);
  });
});
