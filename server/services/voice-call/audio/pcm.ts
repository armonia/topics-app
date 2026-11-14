/**
 * The audio of a call, with no dependencies. The phone side speaks 16 kHz; the
 * call logic counts 60 ms frames (960 samples), Gemini Live listens at 16 kHz
 * and answers at 24 kHz. Here live the rate change, the queue of what the
 * assistant still has to say, and the voice detector that decides what reaches
 * Gemini (every second it receives is billed).
 *
 * Ported from jarvis-channels `src/voice/pcm.rs` (commit 80f1fd26): every
 * threshold below was set by a real call, and the dated notes say which.
 */

/** Samples in one frame of the call logic: 60 ms at 16 kHz. */
export const FRAME = 960;
export const FRAME_MS = 60;

export function i16FromLe(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function i16ToLe(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

/** Rust `f32::round` (half away from zero) followed by a saturating cast to i16. */
export function toI16(x: number): number {
  const r = x < 0 ? -Math.round(-x) : Math.round(x);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

export function concatI16(parts: ArrayLike<number>[]): Int16Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Int16Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p as ArrayLike<number>, at);
    at += p.length;
  }
  return out;
}

const TAPS = 32;

/**
 * 24 to 16 kHz. The ratio is exact (3:2), so two fixed filters are enough: one
 * for the output that lands on an input sample and one for the output that
 * lands halfway between two. The low-pass (Blackman-windowed sinc, cut at
 * 7 kHz) removes what above 8 kHz would fold back as a whistle.
 */
export class Resampler {
  private readonly phases: [Float64Array, Float64Array];
  // the last input samples, for frames that arrive in pieces
  private hist: number[] = new Array(TAPS).fill(0);
  // position of the next output sample, in half input samples from the start of `hist`
  private pos = 2 * TAPS;

  constructor() {
    const cut = 7000 / 24000;
    const half = TAPS / 2;
    const kernel = (x: number): number => {
      // x in input samples from the centre of the filter
      const sinc = Math.abs(x) < 1e-6 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x);
      const n = (x + half) / (2 * half);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
      return n >= 0 && n <= 1 ? sinc * w : 0;
    };
    const build = (offset: number): Float64Array => {
      const k = new Float64Array(TAPS);
      for (let i = 0; i < TAPS; i++) k[i] = kernel(i - half + 1 - offset);
      let sum = 0;
      for (const c of k) sum += c;
      for (let i = 0; i < TAPS; i++) k[i]! /= sum;
      return k;
    };
    this.phases = [build(0), build(0.5)];
  }

  /** 24 kHz samples in, 16 kHz samples out (2 every 3, counting the earlier pieces too). */
  push(input: ArrayLike<number>): Int16Array {
    for (let i = 0; i < input.length; i++) this.hist.push(input[i]!);
    const out: number[] = [];
    // output k lands at 1.5*k input samples: in half samples it moves by 3
    while (this.pos >> 1 < this.hist.length) {
      const base = this.pos >> 1;
      const phase = this.phases[this.pos & 1]!;
      const start = base + 1 - TAPS;
      let acc = 0;
      for (let i = 0; i < TAPS; i++) acc += phase[i]! * this.hist[start + i]!;
      out.push(toI16(acc));
      this.pos += 3;
    }
    // only the samples the filter still needs are kept
    const keepFrom = Math.min(Math.max(0, (this.pos >> 1) - (TAPS - 1)), this.hist.length);
    this.hist.splice(0, keepFrom);
    this.pos -= 2 * keepFrom;
    return Int16Array.from(out);
  }
}

/**
 * The other side's frames arrive as long as its phone decides (40 ms in the call
 * of 10/11, not the library's 60; 20 ms on the bridge): here they are rebuilt
 * as 960-sample frames, because the voice detector, the thresholds and the
 * recording count 60 ms frames. With 40 ms the barge-in fired at 160 ms and the
 * recording lost a third of the voice.
 */
export class Rechunk {
  private buf: number[] = [];

  push(f: ArrayLike<number>): Int16Array[] {
    for (let i = 0; i < f.length; i++) this.buf.push(f[i]!);
    const out: Int16Array[] = [];
    while (this.buf.length >= FRAME) out.push(Int16Array.from(this.buf.splice(0, FRAME)));
    return out;
  }
}

/**
 * What the assistant still has to say, at 16 kHz: one frame every 60 ms on the
 * call's clock. Gemini generates 3-5 times faster than real time, so the queue
 * fills faster than it drains; only an interruption empties it.
 */
export class Playout {
  private queue: number[] = [];
  private head = 0;
  // Gemini's turn is over: the last piece, even a short one, goes out padded with silence
  turnDone = false;

  private get length(): number {
    return this.queue.length - this.head;
  }

  push(samples: ArrayLike<number>): void {
    this.turnDone = false;
    for (let i = 0; i < samples.length; i++) this.queue.push(samples[i]!);
  }

  clear(): number {
    const n = this.length;
    this.queue = [];
    this.head = 0;
    return n;
  }

  isPlaying(): boolean {
    return this.length > 0;
  }

  queuedMs(): number {
    return Math.floor((this.length * 1000) / 16000);
  }

  /**
   * The next frame to send; null = silence. A piece shorter than a frame waits
   * for the rest, until the turn is over.
   */
  nextFrame(): Int16Array | null {
    const len = this.length;
    if (len >= FRAME || (this.turnDone && len > 0)) {
      const n = Math.min(len, FRAME);
      const f = new Int16Array(FRAME);
      for (let i = 0; i < n; i++) f[i] = this.queue[this.head + i]!;
      this.head += n;
      // compact now and then: a 30 minute call must not keep every sample it ever said
      if (this.head > 16000 * 10) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      return f;
    }
    return null;
  }
}

/** Level of a frame in dB relative to full scale (digital silence = -100). */
export function levelDb(frame: ArrayLike<number>): number {
  if (frame.length === 0) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / frame.length) / 32768;
  return rms <= 1e-5 ? -100 : Math.fround(20 * Math.log10(rms));
}

/** What to do with the frame that just arrived from the caller. */
export type Gate =
  /** nothing to send to Gemini */
  | { kind: "closed" }
  /** send these frames (when opening, also the 300 ms before, where the attack of the word is) */
  | { kind: "send"; frames: Int16Array[] }
  /** the phrase is over: the last tail piece is sent, and Gemini is told the microphone is quiet (`audioStreamEnd`) */
  | { kind: "end"; frame: Int16Array };

const PRE_FRAMES = 5; // 300 ms
export const HANG_FRAMES = 17; // ~1 s
const FLOOR_FRAMES = 50; // 3 s
const OVER_FLOOR_DB = 12;
const MIN_VOICE_DB = -48;
export const VAD_PRE_FRAMES = PRE_FRAMES;

/**
 * Interrupting the assistant takes a real voice, not its own echo. The phone
 * sends zeros between words (floor -100 dB), so the threshold relative to the
 * floor filters nothing: in the calls of 11-12/11 the empty interruptions sat
 * between -47 and -35 dBFS (the assistant's echo sent back by the phone, noise),
 * the real ones between -26 and -8. The mean energy of the last frames is what
 * counts, not each one: between two syllables a real voice drops to -44 for a
 * frame.
 */
export const BARGE_MIN_DB = -30;

/**
 * The voice detector on the caller's phone. Gemini bills every second of audio
 * it gets, and every turn pays the whole context again: the silence of a call
 * is not sent. Voice = at least 12 dB over the floor and over -48 dBFS. The
 * floor is the lowest frame of the last 3 s: between words a voice drops to the
 * room noise, a fan never does, and becomes the floor. After the last voice one
 * more second goes out, which Gemini's own VAD needs to close the turn itself.
 */
export class Vad {
  // at the start the floor is that of a phone in a quiet room: a «pronto?» said at once opens
  private levels: number[] = new Array(FLOOR_FRAMES).fill(-60);
  private pre: Int16Array[] = [];
  private open = false;
  // frames without voice in a row, with the gate open
  private quietRun = 0;
  /** frames with voice in a row: they say the other side is talking */
  voicedRun = 0;

  /** The gate is open: the caller is talking (or has just finished, in the trailing second). */
  isOpen(): boolean {
    return this.open;
  }

  private floor(): number {
    let m = Infinity;
    for (const l of this.levels) if (l < m) m = l;
    return m;
  }

  /**
   * (level of the last frame, floor) in dBFS: in the log of an interruption they
   * tell a real voice from the assistant's echo sent back by the phone, which
   * arrives lower.
   */
  levelsDb(): [number, number] {
    return [this.levels[this.levels.length - 1] ?? -90, this.floor()];
  }

  /**
   * Closes the gate without forgetting the floor: the voice heard before the
   * greeting does not go to Gemini, and its tail (one second) must not reach it
   * later as half a phrase followed by an end of speech.
   */
  closeGate(): void {
    this.open = false;
    this.quietRun = 0;
    this.voicedRun = 0;
    this.pre = [];
  }

  /** The caller really talks over the assistant: `n` voiced frames in a row, with mean energy over BARGE_MIN_DB. */
  barges(n: number): boolean {
    if (n === 0 || this.voicedRun < n) return false;
    let power = 0;
    for (let i = 0; i < n; i++) power += Math.pow(10, this.levels[this.levels.length - 1 - i]! / 10);
    power /= n;
    return 10 * Math.log10(power) > BARGE_MIN_DB;
  }

  /** frames of silence since the last voice, with the gate open */
  quiet(): number {
    return this.quietRun;
  }

  push(frame: Int16Array): Gate {
    const db = levelDb(frame);
    this.levels.shift();
    this.levels.push(db);
    const voice = db > MIN_VOICE_DB && db > this.floor() + OVER_FLOOR_DB;
    this.voicedRun = voice ? this.voicedRun + 1 : 0;
    if (!this.open) {
      if (voice) {
        this.open = true;
        this.quietRun = 0;
        const frames = this.pre;
        this.pre = [];
        frames.push(frame);
        return { kind: "send", frames };
      }
      this.pre.push(frame);
      if (this.pre.length > PRE_FRAMES) this.pre.shift();
      return { kind: "closed" };
    }
    this.quietRun = voice ? 0 : this.quietRun + 1;
    if (this.quietRun >= HANG_FRAMES) {
      this.open = false;
      this.quietRun = 0;
      return { kind: "end", frame };
    }
    return { kind: "send", frames: [frame] };
  }
}
