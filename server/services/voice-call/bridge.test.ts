/**
 * The bridge as a channel sees it: a real WebSocket on a real server, a fake
 * channel on one side and a fake Gemini on the other, the protocol of
 * `openspec/changes/chiamate-vocali/protocollo.md` from start to outcome.
 * @covers CALL-05
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeWebSocket } from "../../lib/ws-upgrade";
import { VOICE_BRIDGE_PATH, VoiceBridgeSession, callVocabulary, type BridgeDeps } from "./bridge";
import { FakeGemini, voice16k, voice24k } from "./call.testkit";
import { voiceSettings } from "./config";
import { MOUTH } from "./brain";
import type { OpenGemini } from "./gemini";

type Msg = Record<string, any>;

const homes: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A server with only the bridge on it, wired as server.ts wires it. */
function bridgeServer(deps: BridgeDeps) {
  const server = Bun.serve<{ voiceBridge?: boolean; _voice?: VoiceBridgeSession }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const r = upgradeWebSocket(req, new URL(req.url).pathname, server as never, null, false);
      return r === undefined ? undefined : (r ?? new Response("no", { status: 404 }));
    },
    websocket: {
      open(ws) {
        if (!ws.data.voiceBridge) return ws.close();
        ws.data._voice = new VoiceBridgeSession({ send: (d) => void ws.send(d), close: (c, r) => ws.close(c, r), bufferedAmount: () => ws.getBufferedAmount() }, deps);
      },
      message(ws, m) {
        if (typeof m === "string") ws.data._voice?.onText(m);
        else ws.data._voice?.onBinary(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
      },
      close(ws) {
        ws.data._voice?.onClose();
      },
    },
  });
  servers.push(server);
  return server;
}

/** The fake channel: it keeps every frame it receives, in order. */
async function channel(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_BRIDGE_PATH}`);
  ws.binaryType = "arraybuffer";
  const texts: Msg[] = [];
  const order: string[] = [];
  const frames: { at: number; bytes: number }[] = [];
  let closed = false;
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const m = JSON.parse(ev.data) as Msg;
      texts.push(m);
      if (m.type !== "log") order.push(m.type);
    } else {
      frames.push({ at: performance.now(), bytes: (ev.data as ArrayBuffer).byteLength });
      if (order.at(-1) !== "audio") order.push("audio");
    }
  };
  // like a phone, the channel streams all the time: the queued voice, or digital silence
  const mouth: number[] = [];
  const pump = setInterval(() => {
    if (ws.readyState !== 1) return;
    const f = new Int16Array(960);
    f.set(mouth.splice(0, 960));
    ws.send(new Uint8Array(f.buffer));
  }, 60);
  ws.onclose = () => {
    closed = true;
    clearInterval(pump);
  };
  await new Promise<void>((r, j) => {
    ws.onopen = () => r();
    ws.onerror = () => j(new Error("ws error"));
  });
  const until = async (cond: () => boolean, ms = 8000) => {
    const end = performance.now() + ms;
    while (!cond()) {
      if (performance.now() > end) throw new Error("timeout");
      await Bun.sleep(10);
    }
  };
  return {
    ws,
    texts,
    order,
    frames,
    isClosed: () => closed,
    say: (pcm: Int16Array) => void mouth.push(...pcm),
    until,
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    events: () => texts.filter((m) => m.type === "log").map((m) => m.event as string),
    of: (type: string) => texts.filter((m) => m.type === type),
  };
}

function world(extra: Partial<BridgeDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "voice-bridge-"));
  homes.push(home);
  const gems: FakeGemini[] = [];
  const openGemini: OpenGemini = (s, onEvent) => {
    const g = new FakeGemini(s.system, s.tools, onEvent);
    gems.push(g);
    queueMicrotask(() => onEvent({ type: "ready", resumed: false }));
    return { send: (c) => g.sent.push(c), close: () => (g.closed = true) };
  };
  const settings = voiceSettings({ GEMINI_API_KEY: "test-key", TOPICS_VOICE_ASSISTANT: "Jarvis" });
  const server = bridgeServer({ settings, voiceHome: home, openGemini, convert: async () => false, note: () => {}, ...extra });
  return { home, gems, main: () => gems.find((g) => g.system !== MOUTH)!, port: server.port! };
}

describe("voice bridge", () => {
  test("the upgrade on the bridge path marks the socket as a call", () => {
    let data: Record<string, unknown> | undefined;
    const server = { upgrade: (_r: Request, o: { data: Record<string, unknown> }) => ((data = o.data), true) };
    expect(upgradeWebSocket(new Request(`http://localhost${VOICE_BRIDGE_PATH}`), VOICE_BRIDGE_PATH, server as never, null, false)).toBeUndefined();
    expect(data?.voiceBridge).toBe(true);
  });

  test("a whole call: start, audio, handoff_ok, reply, hangup, outcome", async () => {
    const w = world();
    const c = await channel(w.port);
    c.send({ type: "start", id: "call-1", name: "Ada", direction: { kind: "incoming" }, group: false, speed: 1, record: true });
    c.send({ type: "answered" });
    await c.until(() => w.gems.length > 0 && w.main().texts().length > 0);
    expect(w.main().texts()[0]).toContain("Ciao Ada, dimmi");
    // the greeting: Topics is the clock, one 1920-byte frame every 60 ms
    w.main().emit({ type: "said", text: "Ciao Ada, dimmi." });
    w.main().emit({ type: "audio", pcm: voice24k(500) });
    w.main().emit({ type: "generationDone" });
    w.main().emit({ type: "turnComplete" });
    await c.until(() => c.frames.length >= 20);
    const span = c.frames[19]!.at - c.frames[0]!.at;
    expect(c.frames.slice(0, 20).every((f) => f.bytes === 1920)).toBe(true);
    expect(span).toBeGreaterThan(19 * 60 * 0.8);
    expect(span).toBeLessThan(19 * 60 * 1.6);
    // the caller talks: its 60 ms frames reach Gemini while the voice detector is open
    c.say(voice16k(16000));
    await c.until(() => w.main().audioSamples() > 0);
    await c.until(() => c.events().includes("fine_frase"));
    // Gemini hands a job off: the channel confirms it, and only then the tool answer goes back
    w.main().emit({ type: "said", text: "Ci guardo." });
    w.main().emit({ type: "toolCall", id: "t1", name: "affida_a_jarvis", args: { compito: "le ultime mail" } });
    await c.until(() => c.of("handoff").length === 1);
    const h = c.of("handoff")[0]!;
    expect(h).toEqual({ type: "handoff", id: "call-1:1", text: "le ultime mail" });
    expect(w.main().toolResponses().length).toBe(0);
    c.send({ type: "handoff_ok", id: h.id });
    await c.until(() => w.main().toolResponses().length === 1);
    expect(w.main().toolResponses()[0]!.result).toContain("Passato a Jarvis");
    w.main().emit({ type: "turnComplete" });
    // the steps and the result of the agent's turn
    c.send({ type: "progress", steps: ["Bash: gws-mail gmail +triage"] });
    c.send({ type: "reply", text: "Tre mail nuove, una di Dario sul preventivo." });
    await c.until(() => c.events().includes("risultato_a_gemini"));
    expect(w.main().texts().at(-1)).toContain("Dario sul preventivo");
    // the goodbye: the assistant closes, so the channel hears hangup, then the outcome, then the socket closes
    w.main().emit({ type: "toolCall", id: "h1", name: "chiudi_chiamata", args: {} });
    w.main().emit({ type: "said", text: "Ciao, a dopo." });
    w.main().emit({ type: "audio", pcm: voice24k(300) });
    w.main().emit({ type: "generationDone" });
    w.main().emit({ type: "turnComplete" });
    await c.until(() => c.isClosed());
    const tail = c.order.filter((t) => t !== "audio").slice(-2);
    expect(tail).toEqual(["hangup", "outcome"]);
    const out = c.of("outcome")[0]!;
    expect(out).toMatchObject({ reason: "chiusa da Jarvis", ours: true, answered: true, turns: 3, handoffs: 1, speed: 1 });
    expect(String(out.recording)).toStartWith(join(w.home, "recordings"));
    expect(String(out.recording)).toEndWith("-in-arrivo.wav");
    expect(c.events()[0]).toBe("inizio");
    expect(c.events()).toContain("affidato");
    expect(c.events().at(-1)).toBe("fine");
    expect(w.gems.every((g) => g.closed)).toBe(true);
  });

  test("a channel that drops an outgoing call before the answer closes Gemini at once", async () => {
    const w = world();
    const c = await channel(w.port);
    c.send({ type: "start", name: "Ada", direction: { kind: "outgoing", reason: "le mail di oggi" } });
    await c.until(() => w.gems.length >= 1 && w.main() !== undefined);
    c.ws.close();
    // the clock of an unanswered call would close it only on its own timeout, 45 s later
    await c.until(() => w.gems.every((g) => g.closed), 1000);
  });

  test("a handoff the channel does not confirm in time is an error", async () => {
    const w = world({ handoffTimeoutMs: 150 });
    const c = await channel(w.port);
    c.send({ type: "start", name: "Ada", direction: { kind: "incoming" } });
    await c.until(() => w.gems.length > 0 && w.main().texts().length > 0);
    w.main().emit({ type: "toolCall", id: "t1", name: "affida_a_jarvis", args: { compito: "x" } });
    await c.until(() => w.main().toolResponses().length === 1);
    expect(w.main().toolResponses()[0]!.result).toContain("Non è partito (il canale non ha confermato in 5 s)");
    await c.until(() => c.events().includes("affido_fallito"));
    const err = c.texts.find((m) => m.type === "log" && m.event === "affido_fallito");
    expect(err?.data.compito).toBe("x");
    c.ws.close();
  });

  test("handoff_err says why the job did not leave", async () => {
    const w = world();
    const c = await channel(w.port);
    c.send({ type: "start", name: "Ada", direction: { kind: "incoming" } });
    await c.until(() => w.gems.length > 0 && w.main().texts().length > 0);
    w.main().emit({ type: "toolCall", id: "t1", name: "affida_a_jarvis", args: { compito: "x" } });
    await c.until(() => c.of("handoff").length === 1);
    c.send({ type: "handoff_err", id: c.of("handoff")[0]!.id, error: "canale non avviato" });
    await c.until(() => w.main().toolResponses().length === 1);
    expect(w.main().toolResponses()[0]!.result).toContain("canale non avviato");
    c.ws.close();
  });

  test("the other side hangs up: no hangup back, the outcome, then the socket closes", async () => {
    const w = world();
    const c = await channel(w.port);
    c.send({ type: "start", name: "Ada", direction: { kind: "outgoing", reason: "la riunione è spostata" }, record: false });
    await c.until(() => w.gems.length > 0 && w.main().texts().length > 0);
    expect(w.main().texts()[0]).toContain("«la riunione è spostata»");
    c.send({ type: "ended", why: "rifiutata" });
    await c.until(() => c.isClosed());
    expect(c.of("hangup")).toEqual([]);
    expect(c.of("outcome")[0]).toMatchObject({ reason: "rifiutata", ours: false, answered: false, recording: null });
  });

  test("a socket dropped mid-call closes Gemini", async () => {
    const w = world();
    const c = await channel(w.port);
    c.send({ type: "start", name: "Ada", direction: { kind: "incoming" } });
    await c.until(() => w.gems.length > 0);
    c.ws.close();
    await c.until(() => w.gems.every((g) => g.closed));
  });

  test("a start without a name, or anything before start, is refused", async () => {
    const w = world();
    const a = await channel(w.port);
    a.send({ type: "reply", text: "x" });
    await a.until(() => a.isClosed());
    expect(a.of("error")[0]?.error).toBe("prima di tutto start");
    const b = await channel(w.port);
    b.send({ type: "start", direction: { kind: "incoming" } });
    await b.until(() => b.isClosed());
    expect(b.of("error")[0]?.error).toBe("manca il nome");
  });

  test("the vocabulary of a call names its people, and nobody else's", () => {
    const s = voiceSettings({ TOPICS_VOICE_ORG: "Acme", TOPICS_VOICE_VOCABULARY: "preventivo, Orbita" });
    expect(callVocabulary(s, "Ada")).toEqual(["Dimmi tutto", "Jarvis", "Ada", "Acme", "Topics", "sottoagenti", "preventivo", "chiudi la chiamata", "Orbita"]);
    expect(callVocabulary(voiceSettings({}), "Ada")).not.toContain("Acme");
  });
});
