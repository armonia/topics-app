/**
 * The timing rules and the shapes of a call: every number below was set by a
 * real call that went wrong (10-14/11), the dated notes say which. Ported from
 * the head of jarvis-channels `src/voice/call.rs`.
 */
import type { Thought } from "./brain";
import type { OpenGemini, Usage, VoiceOptions } from "./gemini";
import type { Direction, VoicePersona } from "./prompts";
import { FRAME_MS } from "./audio/pcm";

/** Rings without an answer (outgoing): then it gives up. */
export const RING_MAX = 45_000;
/** Ceiling of a call: past it, almost surely a phone forgotten on. */
export const MAX_CALL = 30 * 60_000;
/** Nobody talks for long: it closes (with a handed-off job running it waits longer, the result can arrive). */
export const IDLE = 3 * 60_000;
export const IDLE_WAITING = 10 * 60_000;
/** Voice in a row that interrupts the assistant while it talks (4 x 60 ms): less, and a cough or an echo silence it. */
export const BARGE_FRAMES = 4;
/** After this silence without an answer a filler starts: the median answer is 0.9 s, the slow ones 1.6-1.8. */
export const FILLER_AFTER = 1300;
/** With the brain the answer surely arrives after 2-4 s: "Ok, give me a moment" starts before, as a person would. */
export const ACK_AFTER = 1600;
/** The brain still thinks: "one more second", once per question. */
export const STILL_THINKING = 6000;
/** A step of the job said aloud no more often than this, and not before the job has been running a while. */
export const PROGRESS_EVERY = 8000;
export const PROGRESS_FROM = 4000;
/** A step does not start if they talked less than this ago: in the pauses inside a phrase the line looks free. */
export const STEP_GAP = 1500;
/** The fillers from here on say it is thinking (fillers.ts, FILLER_LINES). */
export const ACK_FROM = 4;
/** How much voice over the assistant whisper needs to tell if it is words; and how long its answer is awaited. */
export const CHECK_AUDIO_MS = 700;
export const CHECK_MAX = 2500;
/** silence after which whisper already starts (6 x 60 ms): before the gate (1 s) and Gemini's answer (0.7 s) */
export const EARLY_QUIET = 6;
/** how long the start of an answer is held waiting for whisper: it usually arrives 0.1-0.5 s after the first audio */
export const EAR_WAIT = 700;
/** how long a Gemini action waits for whisper's verdict */
export const ACTION_WAIT = 1500;
/** no event from Gemini for this long while "generating": the turn will never close */
export const GEMINI_MUTE = 5000;
/** a finished phrase with no answer: after this whisper's text is sent to it */
export const ANSWER_MISSING = 3500;
/** After a sound that was not voice (music), for a while another loud sound does not pause: it is only checked. */
export const MUSIC_HOLD = 5000;
/**
 * Outgoing, the assistant greets after the other's "Hello?": once they have
 * been quiet for GREET_QUIET, or after GREET_SILENT if they say nothing, and in
 * any case within GREET_MAX (a background noise must not keep it quiet).
 */
export const GREET_QUIET = 400;
export const GREET_SILENT = 1500;
export const GREET_MAX = 4000;
/** How much of the voice said over the assistant is held back, waiting to know if it is an interruption (2.4 s). */
export const HELD_MAX = 40;
/**
 * In a group people talk among themselves and Gemini would answer every phrase:
 * its answer is heard only if the phrase has the name in it, or if it comes
 * within FOLLOW_UP of the last time the assistant talked (the conversation with
 * it goes on). The transcript arrives a bit after the audio: the answer waits
 * for the name up to NAME_WAIT, then it is dropped.
 */
export const FOLLOW_UP = 8000;
export const NAME_WAIT = 900;
/** The clock of the call: one 60 ms frame per tick, the frame of the WhatsApp line (protocollo.md). */
export const CLOCK_MS = FRAME_MS;

export interface CallOutcome {
  reason: string;
  /** the assistant closes it: it is up to us to tell the other phone */
  ours: boolean;
  answered: boolean;
  talkS: number;
  turns: number;
  handoffs: number;
  usage: Usage;
  /** call on behalf: the outcome Gemini gave when closing (what they answered, messages for the owner) */
  report: string | null;
  /** everything the other side said, transcribed: the fallback outcome if the call drops before the goodbye */
  heard: string;
  /** the recording (WAV), if there was one and someone answered */
  recording: string | null;
  /** the speed at the end of the call: if they changed it by voice, it stays for the next ones */
  speed: number;
}

export type WhisperResult = { ok: true; text: string | null } | { ok: false };

/** The doors of a call to the outside, injectable: production wires the real ones, the tests their fakes. */
export interface CallDeps {
  now(): number;
  openGemini: OpenGemini;
  gemini: VoiceOptions & { key: string; model: string; speaksWhileThinking: boolean };
  /** whisper on a phrase; null = no second opinion (no Groq key) */
  whisper: ((pcm: Int16Array) => Promise<WhisperResult>) | null;
  /** one line of the quick voice; null = no quick voice (no Groq key) */
  quick: ((prompt: [string, string]) => Promise<string | null>) | null;
  /** the brain; null = Gemini thinks alone */
  think: ((system: string, user: string) => Promise<{ ok: true; thought: Thought } | { ok: false; error: string }>) | null;
  /** passes a task to the agent (a message of the owner in their chat); rejects = it did not leave */
  handoff(task: string): Promise<void>;
  /** one 60 ms frame of the assistant's voice to the phone; false = the audio is closed */
  toPeer(chunk: Int16Array): boolean;
  /** the phone side is behind: a voiced frame waits for the next tick, a silent one is dropped */
  backlogged?(): boolean;
  /** a line of the call log */
  log(event: string, data: Record<string, unknown>): void;
  /** "Saturday 14/11/2026, 18:05": now, as the prompts say it */
  spokenNow: string;
  debug?: boolean;
}

export interface CallSpec {
  id: string;
  persona: VoicePersona;
  direction: Direction;
  /** where to record the call (both voices in a mono WAV); null = no recording */
  record: string | null;
  /** group call (the owner added the assistant to a call with others): it speaks only when called */
  group: boolean;
  /** speed of the voice (1 = Gemini's); changed by voice during the call */
  speed: number;
  /** fillers with the same voice, PCM at 16 kHz: they cover a long wait before the answer */
  fillers: Int16Array[];
}

export type Ask = { id: string; round: number; phrase: string; seq: number };

const VERSO: Record<string, string> = { group: "di gruppo", incoming: "in arrivo", outgoing: "in uscita", callback: "richiamata per conto", on_behalf: "per conto" };

export function versoOf(d: Direction, group: boolean): string {
  if (d.kind === "incoming") return group ? VERSO.group! : VERSO.incoming!;
  if (d.kind === "outgoing") return VERSO.outgoing!;
  return d.callback ? VERSO.callback! : VERSO.on_behalf!;
}

export const ms = (x: number): number => Math.max(0, Math.round(x));

/** A held phrase shorter than this is a cough or a click, not something said over the greeting. */
export const LATE_MIN_MS = 400;

const HELLO = new Set(["pronto", "pronti", "si", "sì", "ciao", "eccomi", "dimmi", "ehi", "allo", "salve", "buongiorno", "buonasera", "ok", "okay"]);

/**
 * "Hello?", "Yes, hi": what one says on picking up. Over the greeting it must not
 * cut it (10/11, a "Pronto?" truncated it), and after it it needs no answer.
 */
export function onlyGreeting(text: string): boolean {
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => HELLO.has(w));
}
