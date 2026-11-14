/**
 * The bridge between a channel and Topics: `WS /ws/voice/bridge`, one connection
 * per call. The channel carries the audio (it owns the phone line), Topics makes
 * the call. Text frames are JSON with a `type`; binary frames are PCM16
 * little-endian mono 16 kHz, 20 ms (640 bytes), both ways. The contract is
 * `openspec/changes/chiamate-vocali/protocollo.md`.
 */
import { join } from "node:path";
import { i16FromLe, i16ToLe } from "./audio/pcm";
import { DEFAULT_SPEED, clampSpeed } from "./audio/natural";
import { KEEP_MS, compress, sweep, type RunConvert } from "./audio/record";
import { whisper } from "./audio/whisper";
import { quick, think, type Complete } from "./brain";
import { Call, runClock, versoOf, type CallDeps, type Outcome } from "./call";
import { DEFAULT_VOCABULARY, spokenNow, voiceHome as defaultVoiceHome, voiceSettings, type VoiceSettings } from "./config";
import { fillerDir, loadFillers } from "./fillers";
import { openGemini as realOpenGemini, sayOnce, usageUsd, type OpenGemini } from "./gemini";
import type { Direction } from "./prompts";

export { VOICE_BRIDGE_PATH } from "./config";
/** A handoff the channel does not confirm within this is an error. */
export const HANDOFF_TIMEOUT_MS = 5000;
/** Over this much audio queued on the socket the phone is behind (about 2 s of voice). */
const BACKLOG_BYTES = 64 * 1024;

/** The bits of a server WebSocket the bridge uses. */
export interface BridgeSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  bufferedAmount?(): number;
}

export interface BridgeDeps {
  settings?: VoiceSettings;
  voiceHome?: string;
  openGemini?: OpenGemini;
  fetchImpl?: typeof fetch;
  /** the brain's door, resolved at the start of each call; null = no brain */
  complete?: () => Complete | null;
  now?: () => number;
  convert?: RunConvert;
  /** the clock of the call; the tests may drive their own */
  clock?: (call: Call) => () => void;
  note?: (line: string) => void;
  /** how long a handoff waits for the channel's confirmation (the protocol says 5 s) */
  handoffTimeoutMs?: number;
}

type Start = {
  id: string;
  name: string;
  direction: Direction;
  group: boolean;
  speed: number;
  record: boolean;
  channel: string;
};

function parseStart(m: Record<string, unknown>): Start | string {
  const name = typeof m.name === "string" ? m.name.trim() : "";
  if (!name) return "manca il nome";
  const d = (m.direction ?? {}) as Record<string, unknown>;
  let direction: Direction;
  if (d.kind === "incoming") direction = { kind: "incoming" };
  else if (d.kind === "outgoing") direction = { kind: "outgoing", reason: typeof d.reason === "string" ? d.reason : "" };
  else if (d.kind === "on_behalf") {
    const callee = typeof d.callee === "string" ? d.callee.trim() : "";
    const message = typeof d.message === "string" ? d.message.trim() : "";
    if (!callee || !message) return "per conto: servono callee e message";
    direction = { kind: "on_behalf", callee, message, callback: d.callback === true };
  } else return "direction sconosciuta";
  return {
    id: typeof m.id === "string" && m.id ? m.id : crypto.randomUUID(),
    name,
    direction,
    group: m.group === true,
    speed: typeof m.speed === "number" ? clampSpeed(m.speed) : DEFAULT_SPEED,
    record: m.record !== false,
    channel: typeof m.channel === "string" && m.channel.trim() ? m.channel.trim() : "WhatsApp",
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(at);
    const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
    return `${p("year")}${p("month")}${p("day")}-${p("hour")}${p("minute")}${p("second")}`;
  } catch {
    return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  }
}

/** The protocol's last word: what the channel needs to report and to keep (speed). */
export function outcomeMessage(o: Outcome): Record<string, unknown> {
  return {
    type: "outcome",
    reason: o.reason,
    ours: o.ours,
    answered: o.answered,
    talk_s: o.talkS,
    report: o.report,
    heard: o.heard,
    speed: o.speed,
    turns: o.turns,
    handoffs: o.handoffs,
    usd: Math.round(usageUsd(o.usage) * 10000) / 10000,
    recording: o.recording,
  };
}

/** One call on one socket. */
export class VoiceBridgeSession {
  private call: Call | null = null;
  private stopClock: (() => void) | null = null;
  private closed = false;
  private handoffs = new Map<string, { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private handoffN = 0;

  constructor(private readonly sock: BridgeSocket, private readonly deps: BridgeDeps = {}) {}

  private json(m: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.sock.send(JSON.stringify(m));
    } catch {
      /* the socket is going: close() follows */
    }
  }

  private fail(error: string): void {
    this.json({ type: "error", error });
    this.closed = true;
    try {
      this.sock.close(1008, error);
    } catch {
      /* already closed */
    }
  }

  onText(raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.fail("messaggio non JSON");
    }
    if (!m || typeof m !== "object") return this.fail("messaggio non valido");
    if (m.type === "start") return this.start(m);
    const call = this.call;
    if (!call) return this.fail("prima di tutto start");
    switch (m.type) {
      case "answered":
        return call.answered();
      case "progress":
        if (Array.isArray(m.steps)) call.progress(m.steps.filter((s): s is string => typeof s === "string"));
        return;
      case "reply":
        if (typeof m.text === "string" && m.text.trim()) call.reply(m.text);
        return;
      case "ended":
        return call.endedByPeer(typeof m.why === "string" && m.why ? m.why : "riattaccato");
      case "handoff_ok":
      case "handoff_err": {
        const h = typeof m.id === "string" ? this.handoffs.get(m.id) : undefined;
        if (!h) return;
        this.handoffs.delete(m.id as string);
        clearTimeout(h.timer);
        if (m.type === "handoff_ok") h.resolve();
        else h.reject(new Error(typeof m.error === "string" && m.error ? m.error : "rifiutato dal canale"));
        return;
      }
      default:
        return;
    }
  }

  onBinary(bytes: Uint8Array): void {
    this.call?.peerAudio(i16FromLe(bytes));
  }

  /** The socket dropped: the call is over for both (the channel hangs up, Topics closes Gemini). */
  onClose(): void {
    this.closed = true;
    for (const h of this.handoffs.values()) {
      clearTimeout(h.timer);
      h.reject(new Error("socket chiuso"));
    }
    this.handoffs.clear();
    this.call?.shutdown();
  }

  private start(m: Record<string, unknown>): void {
    if (this.call) return this.fail("start due volte");
    const s = parseStart(m);
    if (typeof s === "string") return this.fail(s);
    const settings = this.deps.settings ?? voiceSettings();
    if (!settings.geminiKey) return this.fail("manca GEMINI_API_KEY");
    const home = this.deps.voiceHome ?? defaultVoiceHome();
    const note = this.deps.note ?? ((l: string) => console.warn(l));
    const fetchImpl = this.deps.fetchImpl;
    const geminiBase = { key: settings.geminiKey, model: settings.model, voice: settings.voice, vocabulary: [], thinkingLevel: settings.thinkingLevel };
    const vocabulary = callVocabulary(settings, s.name);
    const open = this.deps.openGemini ?? realOpenGemini;
    const complete = settings.brainModel ? (this.deps.complete?.() ?? null) : null;
    const groq = settings.groqKey;
    const verso = versoOf(s.direction, s.group);
    // in a group there are people who know nothing of the assistant or of the recording: no recording
    let record: string | null = null;
    if (s.record && !s.group) {
      const dir = join(home, "recordings");
      sweep(dir, KEEP_MS);
      const who = s.direction.kind === "on_behalf" ? `-${s.direction.callee.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "-")}` : "";
      record = join(dir, `${stamp(new Date(), settings.timeZone)}-${verso.replace(/ /g, "-")}${who}.wav`);
    }
    const fillers = loadFillers(fillerDir(home, settings.voice), (line) => sayOnce({ ...geminiBase, vocabulary }, line), note);
    const callDeps: CallDeps = {
      now: this.deps.now ?? (() => performance.now()),
      openGemini: (o, onEvent) => open({ ...o, note }, onEvent),
      gemini: { ...geminiBase, vocabulary, speaksWhileThinking: settings.speakWhileThinking },
      whisper: groq ? (pcm) => whisper({ key: groq, fetchImpl }, pcm) : null,
      quick: groq ? (prompt) => quick({ key: groq, model: settings.quickModel, fetchImpl }, prompt) : null,
      think: complete ? (sys, user) => think({ model: settings.brainModel, effort: settings.brainEffort, complete }, sys, user) : null,
      handoff: (task) => this.handoff(s.id, task),
      toPeer: (chunk) => {
        if (this.closed) return false;
        try {
          this.sock.send(i16ToLe(chunk));
          return true;
        } catch {
          return false;
        }
      },
      backlogged: () => (this.sock.bufferedAmount?.() ?? 0) > BACKLOG_BYTES,
      log: (event, data) => this.json({ type: "log", event, data }),
      spokenNow: spokenNow(new Date(), settings.timeZone),
      debug: settings.debug,
    };
    if (!complete && settings.brainModel) note(`voce: cervello ${settings.brainModel} senza provider, Gemini pensa da solo`);
    const call = new Call(
      {
        id: s.id,
        persona: { name: s.name, assistant: settings.assistant, org: settings.org, channel: s.channel, agentLabel: settings.agentLabel },
        direction: s.direction,
        record,
        group: s.group,
        speed: s.speed,
        fillers,
      },
      callDeps,
    );
    this.call = call;
    this.stopClock = (this.deps.clock ?? runClock)(call);
    void call.done.then((o) => this.finish(o));
  }

  private handoff(callId: string, task: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("socket chiuso"));
    const id = `${callId}:${++this.handoffN}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handoffs.delete(id);
        reject(new Error("il canale non ha confermato in 5 s"));
      }, this.deps.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
      this.handoffs.set(id, { resolve, reject, timer });
      this.json({ type: "handoff", id, text: task });
    });
  }

  private async finish(o: Outcome): Promise<void> {
    this.stopClock?.();
    if (o.recording) o.recording = await compress(o.recording, this.deps.convert);
    if (this.closed) return;
    // whoever closes first says so: if the other side hung up, the channel already knows
    if (o.ours) this.json({ type: "hangup", why: o.reason });
    this.json(outcomeMessage(o));
    this.closed = true;
    try {
      this.sock.close(1000, "fine");
    } catch {
      /* already closed */
    }
  }
}

/**
 * The words the input transcription should expect in this call, in the order
 * of the bench of 13/11: the generic ones around the assistant, the owner and
 * the organisation, then the configured extras.
 */
export function callVocabulary(s: VoiceSettings, owner: string): string[] {
  const [first, ...rest] = DEFAULT_VOCABULARY;
  return [...new Set([first!, s.assistant, owner, ...(s.org ? [s.org] : []), ...rest, ...s.vocabulary])];
}
