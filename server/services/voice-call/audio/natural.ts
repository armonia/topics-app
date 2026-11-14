/**
 * What makes the call sound natural beyond the words: the speed of the voice
 * (changed by voice, without changing its pitch), the background of a room in
 * place of digital silence, and whisper's second opinion on the phrases Gemini
 * mishears. Ported from jarvis-channels `src/voice/natural.rs`.
 */
import { i16ToLe, toI16 } from "./pcm";

/** Starting speed: the owner wanted it brisker than Gemini's (12/11). It changes by voice and stays. */
export const DEFAULT_SPEED = 1.12;
export const MIN_SPEED = 0.8;
export const MAX_SPEED = 1.6;

export function clampSpeed(v: number): number {
  const f = Math.fround(v);
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(f) ? f : 1));
}

// WSOLA at 16 kHz: 40 ms windows, 20 ms output hop, alignment search within
// +-10 ms. Shortens or lengthens the voice without changing its pitch: pieces of
// period are repeated or skipped, stitched where the waveform matches.
const N = 640;
const HS = N / 2;
const TOL = 160;

export class Stretch {
  rate: number;
  private inp: number[] = [];
  // absolute index of inp[0]
  private base = 0;
  // nominal (absolute) position of the next window
  private ana = 0;
  // absolute start of the last chosen window
  private prev: number | null = null;
  private acc = new Float64Array(N);
  private readonly win: Float64Array;

  constructor(rate: number) {
    this.rate = rate;
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  }

  private bypass(): boolean {
    return Math.abs(this.rate - 1) < 0.01;
  }

  /** Forgets everything: the answer was interrupted, or is over. */
  reset(): void {
    this.inp = [];
    this.base = 0;
    this.ana = 0;
    this.prev = null;
    this.acc = new Float64Array(N);
  }

  private at(abs: number): number {
    return this.inp[abs - this.base]!;
  }

  push(samples: ArrayLike<number>): Int16Array {
    if (this.bypass() && this.prev === null && this.inp.length === 0) return Int16Array.from(samples);
    for (let i = 0; i < samples.length; i++) this.inp.push(samples[i]!);
    const out: number[] = [];
    for (;;) {
      const end = this.base + this.inp.length;
      const a = Math.round(this.ana);
      let s: number;
      if (this.prev === null) {
        if (a + N > end) break;
        // the first window starts whole, without the entry ramp: no damped attack
        for (let i = 0; i < N; i++) this.acc[i] = i < HS ? this.at(a + i) : this.win[i]! * this.at(a + i);
        s = a;
      } else {
        const p = this.prev;
        if (a + TOL + N > end || p + HS + N > end) break;
        const lo = Math.max(Math.max(0, a - TOL), this.base);
        let best = a;
        let bestC = -Infinity;
        for (let cand = lo; cand <= a + TOL; cand++) {
          let c = 0;
          for (let i = 0; i < N; i += 2) c += this.at(p + HS + i) * this.at(cand + i);
          if (c > bestC) {
            best = cand;
            bestC = c;
          }
        }
        for (let i = 0; i < N; i++) this.acc[i]! += this.win[i]! * this.at(best + i);
        s = best;
      }
      for (let i = 0; i < HS; i++) out.push(toI16(this.acc[i]!));
      this.acc.copyWithin(0, HS);
      this.acc.fill(0, HS);
      this.prev = s;
      this.ana += HS * this.rate;
      // what lies before the oldest window that can still be needed is no longer needed
      const keep = Math.min(s, Math.max(0, Math.floor(this.ana) - TOL));
      if (keep > this.base + 4 * N) {
        this.inp.splice(0, keep - this.base);
        this.base = keep;
      }
    }
    return Int16Array.from(out);
  }

  /**
   * End of the answer: the rest goes out as it is. The tail of the pending
   * window plus its missing half give exactly the input (the two halves of the
   * Hann window sum to 1), so no click.
   */
  flush(): Int16Array {
    const end = this.base + this.inp.length;
    const from = this.prev !== null ? this.prev + HS : Math.max(Math.round(this.ana), this.base);
    const out = from < end ? Int16Array.from({ length: end - from }, (_, k) => toI16(this.at(from + k))) : new Int16Array(0);
    this.reset();
    return out;
  }
}

const ROOM_AMP = 40; // ~-58 dBFS
const KEY_AMP = 900; // peak ~-31 dBFS: audible, and the echo that comes back stays under the voice threshold
const MASK64 = (1n << 64n) - 1n;

/**
 * The background of the call: a room in place of digital silence (which on the
 * phone sounds like a dropped line) and, while the assistant works on a task,
 * the keys of a keyboard. The keys are off in the call loop since 13/11 (the
 * owner found them annoying), the generator keeps them for fidelity.
 */
export class Ambience {
  private rng = 0x9e3779b97f4a7c15n;
  private pink = [0, 0, 0];
  // samples to the next key; keys left in the word
  private nextKey = 8000;
  private wordLeft = 0;
  // key in progress: samples left and amplitude
  private click = 0;
  private clickAmp = 0;
  private hp = 0;

  private rand(): number {
    // xorshift: enough that it does not repeat to the ear
    let r = this.rng;
    r ^= (r << 13n) & MASK64;
    r ^= r >> 7n;
    r ^= (r << 17n) & MASK64;
    this.rng = r;
    return (Number(r >> 40n) / 2 ** 24) * 2 - 1;
  }

  private range(lo: number, hi: number): number {
    return lo + Math.trunc((this.rand() * 0.5 + 0.5) * (hi - lo));
  }

  /** One frame of background: room, and keys if `typing`. */
  frame(len: number, typing: boolean): Int16Array {
    const out = new Int16Array(len);
    for (let k = 0; k < len; k++) {
      const w = this.rand();
      // pink noise (Kellet, short version): less hiss than white
      this.pink[0] = 0.997 * this.pink[0]! + 0.029 * w;
      this.pink[1] = 0.985 * this.pink[1]! + 0.032 * w;
      this.pink[2] = 0.95 * this.pink[2]! + 0.048 * w;
      let x = (this.pink[0]! + this.pink[1]! + this.pink[2]! + 0.02 * w) * ROOM_AMP * 4;
      if (typing) {
        if (this.click === 0) {
          if (this.nextKey === 0) {
            this.click = 110; // ~7 ms
            this.clickAmp = KEY_AMP * (0.6 + 0.4 * (this.rand() * 0.5 + 0.5));
            if (this.wordLeft > 0) {
              this.wordLeft -= 1;
              this.nextKey = this.range(1400, 3200); // 90-200 ms between two keys
            } else {
              this.wordLeft = this.range(2, 8);
              this.nextKey = this.range(5000, 16000); // 0.3-1 s between two words
            }
          } else {
            this.nextKey -= 1;
          }
        }
        if (this.click > 0) {
          const e = this.click / 110;
          const n = this.rand();
          // high-pass: a dry click, not a thud
          const h = n - this.hp;
          this.hp = n;
          x += h * this.clickAmp * e * e;
          this.click -= 1;
        }
      }
      out[k] = toI16(x);
    }
    return out;
  }
}

/** Words of three letters or more, lowercase, split on anything that is not a letter or digit. */
function wordsOf(t: string, dropNumbers: boolean): string[] {
  return t
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => [...w].length >= 3 && !(dropNumbers && /^\d+$/.test(w)));
}

// letters that Italian does not have: ã ê ç ñ ¿ ü ß, hangul...
const ITALIAN_EXTRA = new Set([..."àèéìíòóùúÀÈÉÌÒÙ«»’“”…"]);
const isItalianChar = (c: string): boolean => c.charCodeAt(0) < 128 || ITALIAN_EXTRA.has(c);

/**
 * Did Gemini mishear? Its "heard" against whisper on the same phrase. On the
 * phone Gemini takes short phrases for another language (12/11: a plain
 * "I see" came back as Portuguese, "my mother is ill" as nonsense) and answers
 * "I did not understand"; whisper on the same audio hears them right.
 */
export function misheard(gemini: string, whisper: string): boolean {
  const w = wordsOf(whisper, true);
  if (w.length === 0) return false;
  if (gemini.trim() === "") return true;
  if (![...gemini].every(isItalianChar)) return true;
  const g = wordsOf(gemini, true);
  const stem = (s: string): string => [...s].slice(0, 4).join("");
  const hit = w.filter((x) => g.some((y) => stem(y) === stem(x))).length;
  return w.length >= 2 && hit < 0.5 * w.length;
}

/** The phrases whisper invents over noise: they are not the speaker's. */
export function whisperNoise(t: string): boolean {
  const low = t.toLowerCase();
  const bare = [...low]
    .filter((c) => /[\p{L}\p{N}\s]/u.test(c))
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  // whole phrases whisper writes over music and silence (Groq gives no
  // no_speech_prob: it is always 0); over chords with no words, on 12/11, it
  // wrote a "thanks everyone"
  return (
    ["grazie", "grazie a tutti", "grazie per lascolto", "grazie per la visione", "buona visione"].includes(bare) ||
    ["sottotitoli", "amara.org", "iscriviti", "qtss", "a cura di"].some((p) => low.includes(p))
  );
}

/** Is it its own voice sent back by the phone? The words heard are almost all in what the assistant is saying. */
export function echoOf(said: string, heard: string): boolean {
  const h = wordsOf(heard, false);
  const s = new Set(wordsOf(said, false));
  return h.length > 0 && h.filter((w) => s.has(w)).length * 10 >= h.length * 6;
}

/** A 16 kHz mono PCM16 WAV. */
export function wav16k(pcm: ArrayLike<number>): Uint8Array {
  const data = i16ToLe(pcm);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}
