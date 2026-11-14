/**
 * Gemini Live (BidiGenerateContent) over WebSocket: 16 kHz audio in, 24 kHz
 * audio out, plus the transcripts and the tool calls. Measured in Italian on
 * 09/11: 1.1 s from the end of the question to the first audio.
 * The messages are JSON; here live building and reading (pure, tested) and the
 * connection that hooks back onto the same session when Google closes it
 * (`goAway` every ~10 minutes, or a network drop).
 * Ported from jarvis-channels `src/voice/gemini.rs`.
 */
import { i16FromLe, i16ToLe } from "./audio/pcm";

export type Json = Record<string, unknown>;

export type GeminiEvent =
  /** the session is ready (also after a reconnect) */
  | { type: "ready"; resumed: boolean }
  /** the assistant's voice, PCM at 24 kHz */
  | { type: "audio"; pcm: Int16Array }
  /** the caller talked over while Gemini was generating: what has not gone out yet must be dropped */
  | { type: "interrupted" }
  /**
   * The model has finished generating. The turnComplete arrives only when, at
   * real time, the audio would have finished playing: on a 9 s answer, 9 s
   * after the last piece (13/11), and until then the call stood still.
   */
  | { type: "generationDone" }
  | { type: "turnComplete" }
  | { type: "toolCall"; id: string; name: string; args: Json }
  /** what Gemini heard (input transcription, in pieces) */
  | { type: "heard"; text: string }
  /** what it is saying (output transcription, in pieces) */
  | { type: "said"; text: string }
  | { type: "usage"; usage: Usage }
  /** the connection dropped and will not come back: the call must close */
  | { type: "gone"; why: string };

/** Tokens of a turn as Google counts them. Every turn pays the whole context again: the sum is the bill. */
export interface Usage {
  inAudio: number;
  inText: number;
  outAudio: number;
  outText: number;
}

export const emptyUsage = (): Usage => ({ inAudio: 0, inText: 0, outAudio: 0, outText: 0 });

export function addUsage(a: Usage, o: Usage): void {
  a.inAudio += o.inAudio;
  a.inText += o.inText;
  a.outAudio += o.outAudio;
  a.outText += o.outText;
}

/** Dollars on the paid plan (gemini-3.8-live, $ per million: audio in 3, text in 0.75, audio out 12, text and thinking out 4.5). */
export function usageUsd(u: Usage): number {
  return (u.inAudio * 3 + u.inText * 0.75 + u.outAudio * 12 + u.outText * 4.5) / 1e6;
}

/** Silence after which Gemini considers the phrase over and answers. */
export const SILENCE_MS = 700;

/** What the setup needs besides the model and the prompt. */
export interface VoiceOptions {
  voice: string;
  /** words the input transcription should expect */
  vocabulary: string[];
  /** thinking level of a `...thinking` model */
  thinkingLevel: string;
}

/**
 * The language and a vocabulary for the input transcription: without them
 * Gemini guesses the language phrase by phrase ("Dimmi tutto" came back as
 * French, 100% of the times). Bench of 13/11, two rounds per side on the 21
 * real phrases: misheard phrases 20 -> 9, right words 48% -> 78%, failed checks
 * the same (3 and 3).
 */
function inputTranscription(vocabulary: string[]): Json {
  return { languageCodes: ["it-IT"], customVocabulary: vocabulary };
}

/** The variant that reasons (`...-extended-thinking`) takes a thinking level, the plain one rejects it. */
function generation(model: string, o: VoiceOptions): Json {
  const g: Json = {
    responseModalities: ["AUDIO"],
    speechConfig: { languageCode: "it-IT", voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } },
  };
  if (model.includes("thinking")) g.thinkingConfig = { thinkingLevel: o.thinkingLevel || "low" };
  return g;
}

/**
 * The first message. With `handle` it resumes the session from before (context
 * included). The sliding window keeps the context under 32k tokens: without it
 * a long call pays again, at every phrase, everything said so far.
 */
export function setup(model: string, system: string, tools: unknown, handle: string | null, o: VoiceOptions): Json {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: generation(model, o),
      systemInstruction: { parts: [{ text: system }] },
      tools,
      inputAudioTranscription: inputTranscription(o.vocabulary),
      outputAudioTranscription: {},
      // on the phone people pause mid-phrase: with Gemini's value the assistant
      // started talking after 0.4-0.5 s of silence, over the second half (test of
      // 10/11: 7 interruptions in 16 turns)
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: SILENCE_MS } },
      contextWindowCompression: { slidingWindow: {}, triggerTokens: 32000 },
      sessionResumption: handle ? { handle } : {},
    },
  };
}

export function audio(samples16k: ArrayLike<number>): Json {
  const data = Buffer.from(i16ToLe(samples16k)).toString("base64");
  return { realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } };
}

/** The microphone is quiet: Gemini closes the turn at once instead of waiting for more audio. */
export function streamEnd(): Json {
  return { realtimeInput: { audioStreamEnd: true } };
}

/** A text message that asks for an answer (the start of the call, the result of a handed-off job). */
export function text(t: string): Json {
  return { clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true } };
}

/** The name of the tool through which the voice asks the brain. */
export const ASK_TOOL = "chiedi_a_jarvis";

export function toolResponse(id: string, name: string, result: string, speaksWhileThinking: boolean): Json {
  const response: Json = { result };
  // the brain's answer to a tool that does not block: it is said once Gemini has finished the "one moment" it is saying
  if (name === ASK_TOOL && speaksWhileThinking) response.scheduling = "WHEN_IDLE";
  return { toolResponse: { functionResponses: [{ id, name, response }] } };
}

/*
 * Gemini talking while the brain thinks ("let me look at the mail...") instead
 * of 2-4 s of silence covered by a "Mmh": the ask tool becomes NON_BLOCKING.
 * The owner's idea in the first call with the brain (13/11); it is also the
 * measured gain of the talker-reasoner pattern (ConvFill, LiveKit async tools).
 * Off by default (`speakWhileThinking`): with NON_BLOCKING gemini-3.8-live often
 * did not say the brain's answer, or said it a turn later, and the "one moment"
 * lines sounded wrong. Bench of 13/11, 21 real phrases. The wait is covered by a
 * recorded filler (call.ts, ACK_AFTER).
 */

/** What a server message holds, plus the handle to resume the session and whether it asks to reconnect (`goAway`). */
export interface Parsed {
  events: GeminiEvent[];
  setupComplete: boolean;
  handle: string | null;
  goAway: boolean;
}

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function parse(raw: string): Parsed {
  const p: Parsed = { events: [], setupComplete: false, handle: null, goAway: false };
  let m: Json | null;
  try {
    m = obj(JSON.parse(raw));
  } catch {
    return p;
  }
  if (!m) return p;
  p.setupComplete = "setupComplete" in m;
  p.goAway = "goAway" in m;
  const u = obj(m.sessionResumptionUpdate);
  if (u && u.resumable !== false && typeof u.newHandle === "string" && u.newHandle !== "") p.handle = u.newHandle;
  const sc = obj(m.serverContent);
  if (sc) {
    const it = obj(sc.inputTranscription)?.text;
    if (typeof it === "string" && it !== "") p.events.push({ type: "heard", text: it });
    const ot = obj(sc.outputTranscription)?.text;
    if (typeof ot === "string" && ot !== "") p.events.push({ type: "said", text: ot });
    const parts = obj(sc.modelTurn)?.parts;
    for (const part of Array.isArray(parts) ? parts : []) {
      const d = obj(obj(part)?.inlineData)?.data;
      if (typeof d === "string") p.events.push({ type: "audio", pcm: i16FromLe(Buffer.from(d, "base64")) });
    }
    if (sc.interrupted === true) p.events.push({ type: "interrupted" });
    if (sc.generationComplete === true) p.events.push({ type: "generationDone" });
    if (sc.turnComplete === true) p.events.push({ type: "turnComplete" });
  }
  const calls = obj(m.toolCall)?.functionCalls;
  for (const fc of Array.isArray(calls) ? calls : []) {
    const f = obj(fc) ?? {};
    p.events.push({
      type: "toolCall",
      id: typeof f.id === "string" ? f.id : "",
      name: typeof f.name === "string" ? f.name : "",
      args: obj(f.args) ?? {},
    });
  }
  const um = obj(m.usageMetadata);
  if (um) {
    const usage = emptyUsage();
    for (const d of Array.isArray(um.promptTokensDetails) ? um.promptTokensDetails : []) {
      const n = num(obj(d)?.tokenCount);
      if (obj(d)?.modality === "AUDIO") usage.inAudio += n;
      else usage.inText += n;
    }
    for (const d of Array.isArray(um.responseTokensDetails) ? um.responseTokensDetails : []) {
      const n = num(obj(d)?.tokenCount);
      if (obj(d)?.modality === "AUDIO") usage.outAudio += n;
      else usage.outText += n;
    }
    usage.outText += num(um.thoughtsTokenCount);
    p.events.push({ type: "usage", usage });
  }
  return p;
}

/** What goes to the session. */
export type Cmd =
  | { type: "audio"; pcm: ArrayLike<number> }
  | { type: "streamEnd" }
  | { type: "text"; text: string }
  | { type: "toolResponse"; id: string; name: string; result: string };

export function cmdJson(c: Cmd, speaksWhileThinking: boolean): Json {
  switch (c.type) {
    case "audio":
      return audio(c.pcm);
    case "streamEnd":
      return streamEnd();
    case "text":
      return text(c.text);
    case "toolResponse":
      return toolResponse(c.id, c.name, c.result, speaksWhileThinking);
  }
}

/** The bits of a WebSocket the session uses: the global one in production, a fake in the tests. */
export interface WsLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface SessionOptions extends VoiceOptions {
  key: string;
  model: string;
  system: string;
  tools: unknown;
  speaksWhileThinking: boolean;
  wsFactory?: WsFactory;
  /** waits between attempts; injectable so a test does not sleep */
  sleep?: (ms: number) => Promise<void>;
  /** diagnostics of the connection, never with the key */
  note?: (line: string) => void;
}

/** A frame of the server as text: Google also sends binary frames with the JSON inside. */
async function frameText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data instanceof Blob) return await data.text();
  return null;
}

const isQueued = (c: Cmd): boolean => c.type !== "audio" && c.type !== "streamEnd";

/**
 * Opens the session and keeps it alive until `close()`. Text and tool responses
 * sent while reconnecting wait; the audio of those moments is dropped (it is
 * already old when the session comes back).
 */
export class GeminiSession {
  private ws: WsLike | null = null;
  private ready = false;
  private closed = false;
  private handle: string | null = null;
  private waiting: Cmd[] = [];
  private failures = 0;
  private everReady = false;
  private readonly wsFactory: WsFactory;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: SessionOptions, private readonly onEvent: (e: GeminiEvent) => void) {
    this.wsFactory = o.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    void this.connect();
  }

  send(c: Cmd): void {
    if (this.closed) return;
    if (!this.ready || !this.ws || this.ws.readyState !== 1) {
      if (isQueued(c)) this.waiting.push(c);
      return;
    }
    try {
      this.ws.send(JSON.stringify(cmdJson(c, this.o.speaksWhileThinking)));
    } catch {
      if (isQueued(c)) this.waiting.unshift(c);
    }
  }

  /** whoever opened the session has left it: the end */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close(1000);
    } catch {
      /* already closed */
    }
  }

  private connect(): void {
    if (this.closed) return;
    // the connection error carries the address, which carries the key: only its kind is kept
    let ws: WsLike;
    try {
      ws = this.wsFactory(`${LIVE_URL}?key=${encodeURIComponent(this.o.key)}`);
    } catch {
      void this.retry("connessione non riuscita", false);
      return;
    }
    this.ws = ws;
    this.ready = false;
    ws.binaryType = "arraybuffer";
    let goAway = false;
    let why = "connessione non riuscita";
    let done = false;
    const openTimer = setTimeout(() => {
      if (ws.readyState !== 1) {
        why = "gemini non risponde in 10 s";
        try {
          ws.close();
        } catch {
          /* never opened */
        }
        finish();
      }
    }, 10_000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(openTimer);
      this.ready = false;
      if (this.closed) return;
      void this.retry(why, goAway);
    };
    ws.onopen = () => {
      clearTimeout(openTimer);
      try {
        ws.send(JSON.stringify(setup(this.o.model, this.o.system, this.o.tools, this.handle, this.o)));
      } catch {
        why = "invio fallito";
        finish();
      }
    };
    ws.onmessage = (ev) => {
      void frameText(ev.data).then((raw) => {
        if (raw === null || done) return;
        const p = parse(raw);
        if (p.handle) this.handle = p.handle;
        if (p.setupComplete) {
          this.ready = true;
          this.failures = 0;
          this.onEvent({ type: "ready", resumed: this.everReady });
          this.everReady = true;
          const queued = this.waiting.splice(0);
          for (const c of queued) {
            try {
              ws.send(JSON.stringify(cmdJson(c, this.o.speaksWhileThinking)));
            } catch {
              /* the next reconnect starts from a fresh queue */
            }
          }
        }
        // Google closes soon: reconnect as soon as the turn in progress ends
        goAway ||= p.goAway;
        const turnOver = p.events.some((e) => e.type === "turnComplete");
        for (const e of p.events) this.onEvent(e);
        if (goAway && turnOver) {
          why = "goAway";
          try {
            ws.close();
          } catch {
            /* closing anyway */
          }
          finish();
        }
      });
    };
    ws.onerror = () => {
      why = "errore del WebSocket";
    };
    ws.onclose = (ev) => {
      if (why !== "goAway") why = ev?.code ? `chiusa ${ev.code}: ${ev.reason ?? ""}`.trim() : "chiusa";
      finish();
    };
  }

  /**
   * The goAway is expected and does not count; a rejected setup (wrong model or
   * field) or a network that does not come back are not solved by retrying:
   * four attempts in a row without a ready session and the call closes.
   */
  private async retry(why: string, goAway: boolean): Promise<void> {
    if (!goAway) this.failures += 1;
    if (this.failures > 3) {
      this.closed = true;
      this.onEvent({ type: "gone", why });
      return;
    }
    this.o.note?.(`voce: gemini si riaggancia (${why})${this.handle ? ", stessa sessione" : ""}`);
    await this.sleep(300 * this.failures);
    this.connect();
  }
}

/** Opens a session: the call uses this door, a test passes its own fake. */
export type OpenGemini = (o: SessionOptions, onEvent: (e: GeminiEvent) => void) => { send(c: Cmd): void; close(): void };
export const openGemini: OpenGemini = (o, onEvent) => new GeminiSession(o, onEvent);

/**
 * Makes Gemini say a fixed phrase, with the voice of the calls, and returns its
 * audio at 24 kHz. Used for the fillers ("Mmh...", "Allora..."), which are made
 * once and kept on disk.
 */
export function sayOnce(o: Omit<SessionOptions, "system" | "tools" | "speaksWhileThinking">, line: string): Promise<Int16Array | null> {
  return new Promise((resolve) => {
    const chunks: Int16Array[] = [];
    let settled = false;
    let ws: WsLike;
    const end = (v: Int16Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close(1000);
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => end(null), 20_000);
    try {
      ws = (o.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike))(`${LIVE_URL}?key=${encodeURIComponent(o.key)}`);
    } catch {
      end(null);
      return;
    }
    ws.binaryType = "arraybuffer";
    const system = "Ripeti esattamente il testo che ricevi, in italiano, con il tono di chi riflette un istante al telefono. Nient'altro.";
    ws.onopen = () => ws.send(JSON.stringify(setup(o.model, system, [], null, o)));
    ws.onmessage = (ev) => {
      // Google also sends binary frames with the JSON inside: reading only text
      // frames, from 13/11 no new filler was made any more (a timeout on every
      // line), as already in the call loop
      void frameText(ev.data).then((raw) => {
        if (raw === null) return;
        const p = parse(raw);
        if (p.setupComplete) ws.send(JSON.stringify(text(line)));
        for (const e of p.events) {
          if (e.type === "audio") chunks.push(e.pcm);
          else if (e.type === "generationDone" || e.type === "turnComplete") {
            const n = chunks.reduce((a, c) => a + c.length, 0);
            if (n === 0) return end(null);
            const out = new Int16Array(n);
            let at = 0;
            for (const c of chunks) {
              out.set(c, at);
              at += c.length;
            }
            return end(out);
          }
        }
      });
    };
    ws.onclose = () => end(null);
    ws.onerror = () => end(null);
  });
}
