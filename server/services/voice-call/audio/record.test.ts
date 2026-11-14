/**
 * The recording of a call, ported with the cases of jarvis-channels `record.rs`.
 * @covers CALL-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder, compress, sweep } from "./record";

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "voice-recorder-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sample = (b: Buffer, k: number): number => b.readInt16LE(44 + 2 * k);

describe("record", () => {
  test("the two voices end up mixed in a wav with the right length", () => {
    const r = Recorder.create(join(scratch(), "c.wav"));
    // the other side sends 40 ms pieces: in the assistant's 60 ms frame there is all of the first and half of the second
    r.heard(new Int16Array(640).fill(1000));
    r.heard(new Int16Array(640).fill(1000));
    r.said(new Int16Array(960).fill(500));
    // then the other side is quiet: its 320 samples left, then the assistant alone
    r.said(new Int16Array(960).fill(-200));
    const b = readFileSync(r.finish());
    expect(b.length).toBe(44 + 2 * 1920);
    expect(b.readUInt32LE(40)).toBe(2 * 1920);
    const all = (from: number, to: number, v: number) => Array.from({ length: to - from }, (_, i) => sample(b, from + i)).every((s) => s === v);
    // no hole in the other side's voice
    expect(all(0, 960, 1500)).toBe(true);
    expect(all(960, 1280, 800)).toBe(true);
    expect(all(1280, 1920, -200)).toBe(true);
  });

  test("a loud overlap saturates instead of wrapping", () => {
    const r = Recorder.create(join(scratch(), "c.wav"));
    r.heard([30000, 30000]);
    r.said([30000, 30000]);
    expect(sample(readFileSync(r.finish()), 0)).toBe(32767);
  });

  test("the wav stays when the converter fails, and goes when the m4a is made", async () => {
    const d = scratch();
    const wav = join(d, "c.wav");
    writeFileSync(wav, "x");
    expect(await compress(wav, async () => false, true)).toBe(wav);
    expect(await compress(wav, async (argv) => (writeFileSync(argv[argv.length - 1]!, "aac"), true), true)).toBe(join(d, "c.m4a"));
    expect(existsSync(wav)).toBe(false);
  });

  test("recordings older than the window are removed, the recent ones stay", () => {
    const d = scratch();
    const old = join(d, "old.m4a");
    const fresh = join(d, "fresh.m4a");
    writeFileSync(old, "a");
    writeFileSync(fresh, "b");
    const t = Date.now() / 1000 - 31 * 24 * 3600;
    utimesSync(old, t, t);
    sweep(d, 30 * 24 * 3600 * 1000);
    expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
  });
});
