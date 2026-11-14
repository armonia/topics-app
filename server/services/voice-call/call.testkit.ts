/**
 * A fake world for one call: a clock the test moves, a Gemini the test plays,
 * a phone that records what it receives, and the brain, whisper and quick voice
 * as promises the test resolves. Shared by the call and bridge tests.
 */
import { Call, CLOCK_MS, type CallDeps, type CallSpec, type WhisperResult } from "./call";
import { MOUTH, type Thought } from "./brain";
import type { Cmd, GeminiEvent, OpenGemini } from "./gemini";
import type { Direction } from "./prompts";

export class FakeGemini {
  sent: Cmd[] = [];
  closed = false;
  constructor(readonly system: string, readonly tools: unknown, readonly emit: (e: GeminiEvent) => void) {}
  texts(): string[] {
    return this.sent.filter((c): c is Extract<Cmd, { type: "text" }> => c.type === "text").map((c) => c.text);
  }
  toolResponses(): Extract<Cmd, { type: "toolResponse" }>[] {
    return this.sent.filter((c): c is Extract<Cmd, { type: "toolResponse" }> => c.type === "toolResponse");
  }
  audioSamples(): number {
    return this.sent.reduce((a, c) => a + (c.type === "audio" ? c.pcm.length : 0), 0);
  }
}

/** A deferred value the test settles when it wants. */
export interface Pending<T> {
  args: unknown[];
  resolve(v: T): void;
}

/** 24 kHz tone, as the assistant's voice arrives from Gemini. */
export function voice24k(ms: number, amp = 8000): Int16Array {
  const n = Math.round(24 * ms);
  return Int16Array.from({ length: n }, (_, i) => Math.trunc(amp * Math.sin((2 * Math.PI * 220 * i) / 24000)));
}

/** 16 kHz tone, as the caller's voice arrives from the phone. */
export function voice16k(samples: number, amp = 8000, phase = 0): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) => Math.trunc(amp * Math.sin((2 * Math.PI * 300 * (i + phase)) / 16000)));
}

export interface WorldOptions {
  direction?: Direction;
  brain?: boolean;
  whisper?: boolean;
  quick?: boolean;
  group?: boolean;
  fillers?: Int16Array[];
  record?: string | null;
  speed?: number;
  handoff?: (task: string) => Promise<void>;
}

export class World {
  t = 1_000_000;
  log: { t: number; event: string; data: Record<string, unknown> }[] = [];
  chunks: Int16Array[] = [];
  handed: string[] = [];
  main!: FakeGemini;
  mouth: FakeGemini | null = null;
  thinks: Pending<{ ok: true; thought: Thought } | { ok: false; error: string }>[] = [];
  whispers: Pending<WhisperResult>[] = [];
  quicks: Pending<string | null>[] = [];
  /** what the caller says next: consumed 320 samples per tick */
  private mouthQueue: number[] = [];
  private phase = 0;
  readonly call: Call;

  constructor(o: WorldOptions = {}) {
    const openGemini: OpenGemini = (s, onEvent) => {
      const g = new FakeGemini(s.system, s.tools, onEvent);
      if (s.system === MOUTH) this.mouth = g;
      else this.main = g;
      return { send: (c) => g.sent.push(c), close: () => (g.closed = true) };
    };
    const pending = <T>(list: Pending<T>[]) =>
      (...args: unknown[]) =>
        new Promise<T>((resolve) => list.push({ args, resolve }));
    const deps: CallDeps = {
      now: () => this.t,
      openGemini,
      gemini: { key: "K", model: "gemini-test-live", voice: "V", vocabulary: [], thinkingLevel: "low", speaksWhileThinking: false },
      whisper: o.whisper ? pending(this.whispers) : null,
      quick: o.quick ? pending(this.quicks) : null,
      think: o.brain ? pending(this.thinks) : null,
      handoff: o.handoff ?? (async (task) => void this.handed.push(task)),
      toPeer: (c) => (this.chunks.push(c), true),
      log: (event, data) => this.log.push({ t: this.t, event, data }),
      spokenNow: "sabato 14/11/2026, 18:05",
    };
    const spec: CallSpec = {
      id: "test",
      persona: { name: "Ada", assistant: "Jarvis", org: "", channel: "WhatsApp", agentLabel: "" },
      direction: o.direction ?? { kind: "incoming" },
      record: o.record ?? null,
      group: o.group ?? false,
      speed: o.speed ?? 1,
      fillers: o.fillers ?? [],
    };
    this.call = new Call(spec, deps);
  }

  events(): string[] {
    return this.log.map((l) => l.event);
  }

  has(event: string): boolean {
    return this.log.some((l) => l.event === event);
  }

  first(event: string) {
    return this.log.find((l) => l.event === event);
  }

  /** The caller starts saying `ms` of voice. */
  say(ms: number): void {
    const v = voice16k(ms * 16, 8000, this.phase);
    this.phase += v.length;
    for (const s of v) this.mouthQueue.push(s);
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  /** Moves the clock by `ms`, one 20 ms tick at a time, feeding the phone's audio (voice or digital silence). */
  async advance(ms: number): Promise<void> {
    for (let k = 0; k < Math.round(ms / CLOCK_MS); k++) {
      this.t += CLOCK_MS;
      const piece = this.mouthQueue.splice(0, 320);
      const frame = new Int16Array(320);
      frame.set(piece);
      this.call.peerAudio(frame);
      this.call.tick();
      await this.flush();
    }
  }

  /** Gemini says `ms` of voice in one go and closes the generation (and the turn, when asked). */
  geminiSays(ms: number, said: string, opts: { turn?: boolean; generation?: boolean } = {}): void {
    this.main.emit({ type: "said", text: said });
    this.main.emit({ type: "audio", pcm: voice24k(ms) });
    if (opts.generation !== false) this.main.emit({ type: "generationDone" });
    if (opts.turn) this.main.emit({ type: "turnComplete" });
  }

  /** A loud piece received by the phone in the last `ms`: the assistant was talking. */
  voicedMs(lastMs: number): number {
    const n = Math.round(lastMs / CLOCK_MS);
    return (
      this.chunks.slice(-n).filter((c) => {
        let m = 0;
        for (const s of c) m = Math.max(m, Math.abs(s));
        return m > 2000;
      }).length * CLOCK_MS
    );
  }

  /** The call answered, greeted and free: the opening turn said and played out. */
  async greet(): Promise<void> {
    this.main.emit({ type: "ready", resumed: false });
    if (this.mouth) this.mouth.emit({ type: "ready", resumed: false });
    await this.advance(60);
    this.geminiSays(400, "Ciao Ada, dimmi.", { turn: true });
    await this.advance(800);
  }
}
