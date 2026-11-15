/**
 * The fillers in the voice of the calls, one file per line in
 * `TOPICS_HOME/voice/fillers/<voice>/` (PCM at 16 kHz). Missing ones are made in
 * the background once per process, for the next calls: this one starts without.
 * The last ones (from ACK_FROM) say it is thinking: with the brain on the wait
 * is certain, and a "So..." is not enough (the owner, first call with the brain,
 * 13/11). Ported from `load_fillers` in jarvis-channels `service.rs`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACK_FROM } from "./call";
import { Resampler, i16FromLe, i16ToLe } from "./audio/pcm";

export const FILLER_LINES = ["Un attimo…", "Allora…", "Vediamo…", "Dunque…", "Ok, dammi un attimo.", "Fammi vedere un secondo.", "Mmh, ci penso un attimo."];

let making = false;

/** Says one line with the voice of the calls and returns its 24 kHz audio, or null. */
export type SayLine = (line: string) => Promise<Int16Array | null>;

export function fillerDir(voiceHome: string, voice: string): string {
  return join(voiceHome, "fillers", voice);
}

export function loadFillers(dir: string, say: SayLine | null, note: (l: string) => void = () => {}): Int16Array[] {
  const have: Int16Array[] = [];
  for (let i = 0; i < FILLER_LINES.length; i++) {
    try {
      have.push(i16FromLe(readFileSync(join(dir, `${i}.pcm`))));
    } catch {
      /* not made yet */
    }
  }
  if (have.length < FILLER_LINES.length && say && !making) {
    making = true;
    void makeFillers(dir, say, note)
      // a disk error here is a missing filler, never an unhandled rejection that stops the server
      .catch((e) => note(`voce: intercalari non salvati (${e instanceof Error ? e.message : String(e)})`))
      .finally(() => (making = false));
  }
  return have;
}

export async function makeFillers(dir: string, say: SayLine, note: (l: string) => void = () => {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < FILLER_LINES.length; i++) {
    const line = FILLER_LINES[i]!;
    // the existing ones stay: making them again would change the voice of a filler already heard
    if (existsSync(join(dir, `${i}.pcm`))) continue;
    const a = await say(line);
    if (!a) {
      note(`voce: intercalare «${line}» non generato`);
      continue;
    }
    const pcm = trimSilence(new Resampler().push(a));
    // a long filler is no longer a filler: Gemini now and then adds a phrase. "Ok,
    // give me a moment" said calmly sits between 1.6 and 2.3 s: for those the ceiling is wider
    const maxMs = i >= ACK_FROM ? 2600 : 1500;
    if (pcm.length > 16 * maxMs || pcm.length < 16000 / 5) {
      note(`voce: intercalare «${line}» scartato (${Math.floor(pcm.length / 16)} ms)`);
      continue;
    }
    writeFileSync(join(dir, `${i}.pcm`), i16ToLe(pcm));
  }
}

export function trimSilence(pcm: Int16Array): Int16Array {
  const loud = (s: number) => Math.abs(s) > 400;
  let last = -1;
  for (let i = pcm.length - 1; i >= 0; i--) {
    if (loud(pcm[i]!)) {
      last = i;
      break;
    }
  }
  const end = last < 0 ? 0 : Math.min(last + 1600, pcm.length);
  const cut = pcm.subarray(0, end);
  let first = -1;
  for (let i = 0; i < cut.length; i++) {
    if (loud(cut[i]!)) {
      first = i;
      break;
    }
  }
  const start = first < 0 ? 0 : Math.max(0, first - 480);
  return Int16Array.from(cut.subarray(start));
}
