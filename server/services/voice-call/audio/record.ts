/**
 * The recording of a call: the two voices mixed into a 16 kHz mono WAV, written
 * while people talk (30 minutes held in memory would be more than 100 MB). When
 * the call is over it becomes an m4a where the platform can make one. Kept for
 * 30 days: they are voices of real people, they do not pile up.
 * Ported from jarvis-channels `src/voice/record.rs`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * How much of the other side's voice waits for the assistant's frames to mix
 * with (3 s of samples): the two streams keep their own pace, and past this the
 * oldest is dropped instead of growing. Counted in samples, not frames: the
 * other phone sends them as long as it likes.
 */
const PEER_MAX = 3 * 16_000;
export const KEEP_MS = 30 * 24 * 3600 * 1000;

function header(samples: number): Uint8Array {
  const data = samples * 2;
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, data, true);
  return out;
}

export class Recorder {
  private fd: number;
  private peer: number[] = [];
  private peerHead = 0;
  private samples = 0;

  private constructor(readonly path: string, fd: number) {
    this.fd = fd;
  }

  static create(path: string): Recorder {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "w");
    writeSync(fd, header(0));
    return new Recorder(path, fd);
  }

  /** The other side's voice, any length. */
  heard(f: ArrayLike<number>): void {
    for (let i = 0; i < f.length; i++) this.peer.push(f[i]!);
    const over = this.peer.length - this.peerHead - PEER_MAX;
    if (over > 0) this.peerHead += over;
    if (this.peerHead > PEER_MAX) {
      this.peer = this.peer.slice(this.peerHead);
      this.peerHead = 0;
    }
  }

  /** The frame the assistant just sent (voice or silence): written mixed with the other side's. */
  said(f: ArrayLike<number>): void {
    const buf = new Uint8Array(f.length * 2);
    const v = new DataView(buf.buffer);
    for (let i = 0; i < f.length; i++) {
      const p = this.peerHead < this.peer.length ? this.peer[this.peerHead++]! : 0;
      const s = f[i]! + p;
      v.setInt16(i * 2, s > 32767 ? 32767 : s < -32768 ? -32768 : s, true);
    }
    this.samples += f.length;
    writeSync(this.fd, buf);
  }

  /** Closes the file with the real lengths in the header. */
  finish(): string {
    writeSync(this.fd, header(this.samples), 0, 44, 0);
    closeSync(this.fd);
    return this.path;
  }
}

/** Runs a converter and says whether it succeeded; injectable so a test never spawns one. */
export type RunConvert = (argv: string[]) => Promise<boolean>;

const AFCONVERT = "/usr/bin/afconvert";

async function spawnConvert(argv: string[]): Promise<boolean> {
  try {
    const p = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * The WAV becomes an m4a (AAC, ~6 KB/s against 32) with macOS `afconvert`, and
 * the WAV is removed. Where the conversion is not available or fails the WAV
 * stays: it plays just the same.
 */
export async function compress(wav: string, run: RunConvert = spawnConvert, hasConverter = existsSync(AFCONVERT)): Promise<string> {
  if (!hasConverter) return wav;
  const m4a = wav.replace(/\.wav$/i, "") + ".m4a";
  const ok = await run([AFCONVERT, "-f", "m4af", "-d", "aac", "-b", "32000", wav, m4a]);
  let size = 0;
  try {
    size = statSync(m4a).size;
  } catch {
    /* no m4a: it stays a WAV */
  }
  if (ok && size > 0) {
    try {
      unlinkSync(wav);
    } catch {
      /* already gone */
    }
    return m4a;
  }
  try {
    unlinkSync(m4a);
  } catch {
    /* nothing to remove */
  }
  return wav;
}

/** Removes the recordings older than `keepMs`. */
export function sweep(dir: string, keepMs: number, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (now - statSync(p).mtimeMs > keepMs) unlinkSync(p);
    } catch {
      /* raced with another sweep */
    }
  }
}
