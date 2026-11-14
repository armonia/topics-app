/**
 * The audio primitives of a call, ported with the cases of jarvis-channels `pcm.rs`.
 * @covers CALL-01
 */
import { describe, expect, test } from "bun:test";
import { FRAME, TRAILING_FRAMES, PlaybackQueue, FrameBuilder, Resampler, VAD_PRE_FRAMES, Vad, joinSamples } from "./pcm";

/** Rust `as i16` from a float: truncation toward zero, saturating. */
const castI16 = (x: number): number => Math.max(-32768, Math.min(32767, Math.trunc(x)));

function tone(freq: number, rate: number, n: number, amp: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = castI16(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

function rootMeanSquare(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** The LCG of the Rust test, with the same u32 wrap and the same i16 reinterpretation. */
function noise(amp: number, seed: { v: number }): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    seed.v = (Math.imul(seed.v, 1664525) + 1013904223) >>> 0;
    let s = seed.v >>> 16;
    if (s >= 32768) s -= 65536;
    out[i] = s % Math.max(1, amp);
  }
  return out;
}

function sineAtDb(db: number): Int16Array {
  const amp = 32768 * Math.pow(10, db / 20) * Math.SQRT2;
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) out[i] = castI16(Math.sin(i * 0.2) * amp);
  return out;
}

describe("pcm", () => {
  test("an echo under the barge level is voice but does not interrupt", () => {
    let v = new Vad();
    // the echo seen in the log: voice for the detector, but not an interruption
    for (const db of [-40, -38, -35, -47, -42]) v.push(sineAtDb(db));
    expect(v.voicedRun).toBeGreaterThanOrEqual(4);
    expect(v.barges(4)).toBe(false);
    // "Wait, one more..." said by the macOS voice: a dip to -44 between syllables, and it interrupts anyway
    v = new Vad();
    for (const db of [-13, -20, -44, -15]) v.push(sineAtDb(db));
    expect(v.barges(4)).toBe(true);
  });

  test("frames of any length come out as 60 ms frames without losing samples", () => {
    const r = new FrameBuilder();
    const out: Int16Array[] = [];
    for (let k = 0; k < 6; k++) out.push(...r.push(new Int16Array(640).fill(k)));
    // 6 x 640 = 3840 = 4 x 960
    expect(out.length).toBe(4);
    expect(out.every((f) => f.length === FRAME)).toBe(true);
    const want = joinSamples([0, 1, 2, 3, 4, 5].map((k) => new Int16Array(640).fill(k)));
    expect(Array.from(joinSamples(out))).toEqual(Array.from(want));
    expect(r.push(new Int16Array(100).fill(1)).length).toBe(0);
  });

  test("20 ms frames from the bridge become 60 ms frames, three to one", () => {
    const r = new FrameBuilder();
    const sizes = [1, 2, 3, 4, 5, 6].map((k) => r.push(new Int16Array(320).fill(k)).length);
    expect(sizes).toEqual([0, 0, 1, 0, 0, 1]);
  });

  test("resampling keeps two samples out of three across any chunking", () => {
    const input = tone(440, 24000, 24000, 8000);
    const whole = new Resampler().push(input);
    const pieces = new Resampler();
    const split: Int16Array[] = [];
    for (let i = 0; i < input.length; i += 337) split.push(pieces.push(input.subarray(i, i + 337)));
    expect(whole.length).toBe(16000);
    // the result does not depend on how the pieces arrive
    expect(Array.from(joinSamples(split))).toEqual(Array.from(whole));
  });

  test("speech band passes and what would alias is cut", () => {
    // 1 kHz passes almost intact (in the middle, far from the filter's attack)
    let out = new Resampler().push(tone(1000, 24000, 24000, 8000));
    const gain = rootMeanSquare(out.subarray(1000, 15000)) / (8000 / Math.SQRT2);
    expect(gain).toBeGreaterThan(0.97);
    expect(gain).toBeLessThan(1.03);
    // the frequency stays 1 kHz: 2000 zero crossings in a second
    let crossings = 0;
    for (let i = 1; i < 16000; i++) if (out[i - 1]! < 0 !== out[i]! < 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(1990);
    expect(crossings).toBeLessThanOrEqual(2010);
    // 11 kHz at 16 kHz would become a whistle at 5 kHz: it must vanish (at least -40 dB)
    out = new Resampler().push(tone(11000, 24000, 24000, 8000));
    const attenuation = 20 * Math.log10(rootMeanSquare(out.subarray(1000, 15000)) / (8000 / Math.SQRT2));
    expect(attenuation).toBeLessThan(-40);
  });

  test("playout sends whole frames and pads only the last piece", () => {
    const p = new PlaybackQueue();
    p.push(new Int16Array(FRAME + 100).fill(1));
    expect(p.nextFrame()?.length).toBe(FRAME);
    // 100 samples wait for the rest of the answer
    expect(p.nextFrame()).toBeNull();
    p.turnDone = true;
    const last = p.nextFrame()!;
    expect([last.length, last[99], last[100]]).toEqual([FRAME, 1, 0]);
    expect(p.isPlaying()).toBe(false);
    p.push(new Int16Array(10).fill(5));
    // a new piece reopens the turn
    expect(p.turnDone).toBe(false);
    expect(p.clear()).toBe(10);
  });

  test("the silence of the room never reaches gemini and a phrase does with its attack", () => {
    const v = new Vad();
    const seed = { v: 7 };
    // 3 s of room (noise around -55 dBFS)
    for (let i = 0; i < 50; i++) expect(v.push(noise(100, seed)).kind).toBe("closed");
    // the voice opens: out come the 300 ms before plus the frame
    const first = v.push(tone(300, 16000, FRAME, 6000));
    expect(first.kind).toBe("send");
    if (first.kind === "send") expect(first.frames.length).toBe(VAD_PRE_FRAMES + 1);
    for (let i = 0; i < 10; i++) {
      const g = v.push(tone(300, 16000, FRAME, 6000));
      expect(g.kind === "send" && g.frames.length === 1).toBe(true);
    }
    // after the phrase, ~1 s of tail and then the close, once
    let sent = 0;
    let ended = 0;
    for (let i = 0; i < 40; i++) {
      const g = v.push(noise(100, seed));
      if (g.kind === "send") sent++;
      else if (g.kind === "end") ended++;
    }
    expect([sent, ended]).toEqual([TRAILING_FRAMES - 1, 1]);
  });

  test("a noisy room becomes the floor and stops opening the gate", () => {
    const v = new Vad();
    const seed = { v: 3 };
    // a loud fan (around -25 dBFS): at first it opens, until the 3 s of floor learn it
    let opens = 0;
    let open = false;
    for (let i = 0; i < 300; i++) {
      const g = v.push(noise(3000, seed));
      if (g.kind === "send" && !open) {
        opens++;
        open = true;
      } else if (g.kind !== "send") open = false;
    }
    // constant noise must open at most once and then close
    expect([opens, open]).toEqual([1, false]);
    // a loud voice still opens
    expect(v.push(tone(300, 16000, FRAME, 25000)).kind).toBe("send");
  });
});
