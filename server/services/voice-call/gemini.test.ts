/**
 * Gemini Live messages and the session that hooks back on, ported with the cases of jarvis-channels `gemini.rs`.
 * @covers CALL-02
 */
import { describe, expect, test } from "bun:test";
import { GeminiSession, type GeminiEvent, type WsLike, audio, parse, sayOnce, setup, toolResponse, usageUsd } from "./gemini";

const opts = { voice: "Algenib", vocabulary: ["Dimmi tutto"], thinkingLevel: "low" };

describe("gemini messages", () => {
  test("the setup asks for audio, transcripts, a bounded context and resumption", () => {
    const tools = [{ functionDeclarations: [] }];
    const s = setup("gemini-3.8-live", "Sei l'assistente", tools, null, opts) as any;
    expect(s.setup.model).toBe("models/gemini-3.8-live");
    expect(s.setup.generationConfig.responseModalities[0]).toBe("AUDIO");
    expect(s.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Algenib");
    expect(s.setup.generationConfig.thinkingConfig).toBeUndefined();
    expect(s.setup.inputAudioTranscription).toEqual({ languageCodes: ["it-IT"], customVocabulary: ["Dimmi tutto"] });
    expect(s.setup.sessionResumption).toEqual({});
    expect(typeof s.setup.contextWindowCompression.slidingWindow).toBe("object");
    expect(s.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(700);
    const r = setup("m-extended-thinking", "x", tools, "H1", opts) as any;
    expect(r.setup.sessionResumption.handle).toBe("H1");
    expect(r.setup.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  test("audio goes out as little endian pcm and comes back the same", () => {
    const a = audio([1, -2, 300]) as any;
    expect(a.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    const msg = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: a.realtimeInput.audio.data } }] } } };
    const ev = parse(JSON.stringify(msg)).events;
    expect(ev.length).toBe(1);
    expect(ev[0]!.type === "audio" && Array.from(ev[0]!.pcm)).toEqual([1, -2, 300]);
  });

  test("generation end comes before the turn end", () => {
    expect(parse(JSON.stringify({ serverContent: { generationComplete: true } })).events).toEqual([{ type: "generationDone" }]);
  });

  test("reads transcripts, interruptions, turn end, tools and usage", () => {
    const m = {
      serverContent: { inputTranscription: { text: "quanto fa" }, outputTranscription: { text: "Fa" }, interrupted: true, turnComplete: true },
      toolCall: { functionCalls: [{ id: "c1", name: "affida_a_jarvis", args: { compito: "mail di Dario" } }] },
      usageMetadata: {
        promptTokensDetails: [{ modality: "AUDIO", tokenCount: 100 }, { modality: "TEXT", tokenCount: 900 }],
        responseTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }],
        thoughtsTokenCount: 10,
      },
    };
    expect(parse(JSON.stringify(m)).events).toEqual([
      { type: "heard", text: "quanto fa" },
      { type: "said", text: "Fa" },
      { type: "interrupted" },
      { type: "turnComplete" },
      { type: "toolCall", id: "c1", name: "affida_a_jarvis", args: { compito: "mail di Dario" } },
      { type: "usage", usage: { inAudio: 100, inText: 900, outAudio: 50, outText: 10 } },
    ]);
    expect(Math.abs(usageUsd({ inAudio: 1_000_000, inText: 0, outAudio: 1_000_000, outText: 0 }) - 15)).toBeLessThan(1e-9);
  });

  test("keeps the resumption handle only when the session can resume", () => {
    expect(parse(JSON.stringify({ sessionResumptionUpdate: { newHandle: "H2", resumable: true } })).handle).toBe("H2");
    expect(parse(JSON.stringify({ sessionResumptionUpdate: { newHandle: "H3", resumable: false } })).handle).toBeNull();
    expect(parse(JSON.stringify({ goAway: { timeLeft: "10s" } })).goAway).toBe(true);
    expect(parse(JSON.stringify({ setupComplete: {} })).setupComplete).toBe(true);
    expect(parse("non json")).toEqual({ events: [], setupComplete: false, handle: null, goAway: false });
  });

  test("the ask tool is scheduled when idle only when gemini speaks while thinking", () => {
    const r = (on: boolean) => (toolResponse("i", "chiedi_a_jarvis", "ok", on) as any).toolResponse.functionResponses[0].response;
    expect(r(false)).toEqual({ result: "ok" });
    expect(r(true)).toEqual({ result: "ok", scheduling: "WHEN_IDLE" });
  });
});

/** A fake of the Live socket: the test plays the server. */
class FakeWs implements WsLike {
  readyState = 0;
  binaryType = "blob";
  sent: any[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  server(m: unknown, binary = false) {
    const s = JSON.stringify(m);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(s).buffer : s });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function session() {
  const sockets: FakeWs[] = [];
  const events: GeminiEvent[] = [];
  const s = new GeminiSession(
    { ...opts, key: "K", model: "m", system: "S", tools: [], speaksWhileThinking: false, wsFactory: (u) => (sockets.push(new FakeWs(u)), sockets.at(-1)!), sleep: async () => {} },
    (e) => events.push(e),
  );
  return { s, sockets, events };
}

describe("gemini session", () => {
  test("text sent before the session is ready waits, audio of that moment is dropped", async () => {
    const { s, sockets, events } = session();
    s.send({ type: "text", text: "saluta" });
    s.send({ type: "audio", pcm: [1, 2] });
    sockets[0]!.open();
    expect(sockets[0]!.sent.map((m) => Object.keys(m)[0])).toEqual(["setup"]);
    sockets[0]!.server({ setupComplete: {} }, true);
    await tick();
    expect(events).toEqual([{ type: "ready", resumed: false }]);
    expect(sockets[0]!.sent.map((m) => Object.keys(m)[0])).toEqual(["setup", "clientContent"]);
    s.close();
  });

  test("after a goAway it hooks back onto the same session at the end of the turn", async () => {
    const { s, sockets, events } = session();
    sockets[0]!.open();
    sockets[0]!.server({ setupComplete: {} });
    sockets[0]!.server({ sessionResumptionUpdate: { newHandle: "H9", resumable: true } });
    sockets[0]!.server({ goAway: { timeLeft: "5s" } });
    await tick();
    expect(sockets.length).toBe(1);
    sockets[0]!.server({ serverContent: { turnComplete: true } });
    await tick();
    await tick();
    expect(sockets.length).toBe(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent[0].setup.sessionResumption).toEqual({ handle: "H9" });
    sockets[1]!.server({ setupComplete: {} });
    await tick();
    expect(events.filter((e) => e.type === "ready")).toEqual([{ type: "ready", resumed: false }, { type: "ready", resumed: true }]);
    s.close();
  });

  test("four attempts without a ready session and the call is told the line is gone", async () => {
    const { sockets, events } = session();
    for (let i = 0; i < 4; i++) {
      await tick();
      sockets[i]!.readyState = 3;
      sockets[i]!.onclose?.({ code: 1007, reason: "bad setup" });
      await tick();
    }
    expect(sockets.length).toBe(4);
    expect(events.at(-1)).toEqual({ type: "gone", why: "chiusa 1007: bad setup" });
  });

  test("the key never shows up in what the session tells", async () => {
    const notes: string[] = [];
    const sockets: FakeWs[] = [];
    new GeminiSession(
      { ...opts, key: "SECRET", model: "m", system: "S", tools: [], speaksWhileThinking: false, wsFactory: (u) => (sockets.push(new FakeWs(u)), sockets.at(-1)!), sleep: async () => {}, note: (l) => notes.push(l) },
      () => {},
    ).close();
    expect(notes.join(" ")).not.toContain("SECRET");
  });
});

describe("sayOnce", () => {
  test("reads the audio from binary frames and stops at the end of generation", async () => {
    let ws: FakeWs | null = null;
    const p = sayOnce({ ...opts, key: "K", model: "m", wsFactory: (u) => (ws = new FakeWs(u)) }, "Allora...");
    ws!.open();
    ws!.server({ setupComplete: {} }, true);
    await tick();
    expect(ws!.sent[1]).toEqual({ clientContent: { turns: [{ role: "user", parts: [{ text: "Allora..." }] }], turnComplete: true } });
    const data = Buffer.from(new Int16Array([7, 8]).buffer).toString("base64");
    ws!.server({ serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } }, true);
    ws!.server({ serverContent: { generationComplete: true } }, true);
    expect(Array.from((await p)!)).toEqual([7, 8]);
  });
});
