/**
 * Speed, background, echo and mishearing, ported with the cases of jarvis-channels `natural.rs`.
 * @covers CALL-01
 */
import { describe, expect, test } from "bun:test";
import { Ambience, Stretch, echoOf, misheard, whisperNoise, wav16k } from "./natural";
import { concatI16, levelDb } from "./pcm";
import { whisper } from "./whisper";

function tone(len: number, hz: number): Int16Array {
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.trunc(Math.sin((i * hz * 2 * Math.PI) / 16000) * 8000);
  return out;
}

function pitch(x: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings++;
  return (crossings * 16000) / x.length;
}

describe("natural", () => {
  test("faster speech is shorter but keeps its pitch", () => {
    const input = tone(32000, 180);
    const s = new Stretch(1.25);
    const parts: Int16Array[] = [];
    // in pieces of any size, as they arrive from Gemini
    for (let i = 0; i < input.length; i += 777) parts.push(s.push(input.subarray(i, i + 777)));
    parts.push(s.flush());
    const out = concatI16(parts);
    const ratio = input.length / out.length;
    expect(Math.abs(ratio - 1.25)).toBeLessThan(0.03);
    expect(Math.abs(pitch(out.subarray(1000, out.length - 1000)) - 180)).toBeLessThan(4);
  });

  test("at speed one the voice passes untouched", () => {
    const input = tone(5000, 200);
    const s = new Stretch(1);
    expect(Array.from(s.push(input))).toEqual(Array.from(input));
    expect(s.flush().length).toBe(0);
  });

  test("the room is quiet and typing is louder but under the voice threshold", () => {
    const a = new Ambience();
    const room = concatI16(Array.from({ length: 50 }, () => a.frame(960, false)));
    const typing = concatI16(Array.from({ length: 50 }, () => a.frame(960, true)));
    expect(levelDb(room)).toBeLessThan(-50);
    expect(levelDb(room)).toBeGreaterThan(-70);
    expect(levelDb(typing)).toBeGreaterThan(levelDb(room));
    expect(Math.max(...Array.from(typing, (s) => Math.abs(s)))).toBeLessThan(2000);
  });

  test("what whisper writes over music is not speech", () => {
    expect(whisperNoise(" Grazie a tutti.")).toBe(true);
    expect(whisperNoise("Grazie.")).toBe(true);
    expect(whisperNoise("Sottotitoli creati dalla comunità Amara.org")).toBe(true);
    expect(whisperNoise("Basta così, grazie.")).toBe(false);
    expect(whisperNoise("Aspetta.")).toBe(false);
  });

  test("his own voice back from the phone is an echo, a new word is not", () => {
    const said = "Ti stavo dicendo che oggi il meteo è stato molto variabile";
    expect(echoOf(said, "il meteo è stato molto variabile")).toBe(true);
    expect(echoOf(said, "Aspetta, basta")).toBe(false);
    expect(echoOf(said, "no")).toBe(false);
  });

  test("a short phrase heard as another language is misheard", () => {
    expect(misheard("cadê?", "ah ho capito")).toBe(true);
    expect(misheard("So, ich kann so gerne", "sì, io posso farlo volentieri")).toBe(true);
    expect(misheard("기다려.", "aspetta")).toBe(true);
    expect(misheard("", "dimmi una barzelletta")).toBe(true);
    expect(misheard("Dimmi una barzelletta.", "Dimmi una barzelletta.")).toBe(false);
    expect(misheard("Quanto fa 17 * 23?", "Quanto fa 17 per 23?")).toBe(false);
    expect(misheard("Mi senti bene?", "mi senti bene")).toBe(false);
    expect(misheard("Aha.", "")).toBe(false);
    // one word is too little to judge by stems: only another alphabet gives it away
    expect(misheard("Ok.", "aspetta")).toBe(false);
  });

  test("the wav header says 16 kHz mono and the right length", () => {
    const w = wav16k([1, -2, 3]);
    const v = new DataView(w.buffer);
    expect(w.length).toBe(44 + 6);
    expect([v.getUint32(24, true), v.getUint16(22, true), v.getUint32(40, true), v.getInt16(46, true)]).toEqual([16000, 1, 6, -2]);
  });

  test("whisper keeps only the segments it is sure of, and drops what it invents over music", async () => {
    const reply = (segments: unknown) => (async () => new Response(JSON.stringify({ segments }))) as unknown as typeof fetch;
    const sure = { text: " Dimmi tutto", no_speech_prob: 0.1, avg_logprob: -0.3 };
    const unsure = { text: " rumore", no_speech_prob: 0.9, avg_logprob: -0.3 };
    expect(await whisper({ key: "k", fetchImpl: reply([sure, unsure]) }, [0])).toEqual({ ok: true, text: "Dimmi tutto" });
    expect(await whisper({ key: "k", fetchImpl: reply([{ text: "Grazie a tutti." }]) }, [0])).toEqual({ ok: true, text: null });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await whisper({ key: "k", fetchImpl: down }, [0])).toEqual({ ok: false });
  });
});
