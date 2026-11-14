/**
 * The configuration of the voice calls, read from the environment with a
 * generic default for every value: nothing here belongs to one user. Keys sit
 * next to the other voice routes (`GEMINI_API_KEY`, `GROQ_API_KEY`).
 */
import { join } from "node:path";
import { homedir } from "node:os";

/** The route a channel opens to carry one call. */
export const VOICE_BRIDGE_PATH = "/ws/voice/bridge";

export const DEFAULT_VOICE_MODEL = "gemini-3.8-live";
/**
 * An explicit male voice: without it Gemini uses its default, at 180 Hz of mean
 * pitch, which on the phone sounds female (measured 12/11; Algenib 97 Hz,
 * picked on samples; Charon 149, Fenrir 133, Iapetus 137).
 */
export const DEFAULT_VOICE_NAME = "Algenib";
export const DEFAULT_QUICK_MODEL = "qwen/qwen3.8-27b";
export const DEFAULT_ASSISTANT = "Jarvis";
/** Words the input transcription is told to expect, before the names of this call. */
export const DEFAULT_VOCABULARY = ["Dimmi tutto", "Topics", "sottoagenti", "preventivo", "chiudi la chiamata"];

export interface VoiceSettings {
  /** Gemini Live model of the voice (`TOPICS_VOICE_MODEL`) */
  model: string;
  /** prebuilt Gemini voice (`TOPICS_VOICE_NAME`) */
  voice: string;
  /** the brain's model; empty = Gemini thinks alone (`TOPICS_VOICE_BRAIN_MODEL`) */
  brainModel: string;
  /** which Topics provider runs the brain; empty = the default provider (`TOPICS_VOICE_BRAIN_PROVIDER`) */
  brainProvider: string;
  /** reasoning effort passed to the brain, empty = the model's own (`TOPICS_VOICE_BRAIN_EFFORT`) */
  brainEffort: string;
  /** Groq model of the quick voice (`TOPICS_VOICE_QUICK_MODEL`) */
  quickModel: string;
  /** the assistant's spoken name (`TOPICS_VOICE_ASSISTANT`) */
  assistant: string;
  /** where the owner works, said in the prompts when set (`TOPICS_VOICE_ORG`) */
  org: string;
  /** who does the handed-off jobs, said when asked which model it is; empty = the assistant with its tools (`TOPICS_VOICE_AGENT_LABEL`) */
  agentLabel: string;
  /** extra words for the input transcription, comma separated (`TOPICS_VOICE_VOCABULARY`) */
  vocabulary: string[];
  /** IANA time zone of "now" in the prompts; empty = this machine's (`TOPICS_VOICE_TZ`) */
  timeZone: string;
  /** thinking level of a `...thinking` Live model (`TOPICS_VOICE_THINKING_LEVEL`) */
  thinkingLevel: string;
  /** Gemini talks while the brain thinks, through a NON_BLOCKING tool (`TOPICS_VOICE_SPEAK_WHILE_THINKING=1`). allow-italian: NON_BLOCKING is the API constant */
  speakWhileThinking: boolean;
  /** every Gemini event in the call log (`TOPICS_VOICE_DEBUG=1`) */
  debug: boolean;
  /** folder of the bench scenarios (`TOPICS_VOICE_SCENARIOS`) */
  scenarios: string;
  geminiKey: string;
  groqKey: string;
}

type Env = Record<string, string | undefined>;

const str = (env: Env, k: string, d = ""): string => (env[k] ?? "").trim() || d;

export function voiceSettings(env: Env = process.env): VoiceSettings {
  const brain = str(env, "TOPICS_VOICE_BRAIN_MODEL");
  return {
    model: str(env, "TOPICS_VOICE_MODEL", DEFAULT_VOICE_MODEL),
    voice: str(env, "TOPICS_VOICE_NAME", DEFAULT_VOICE_NAME),
    // "0" switches the brain off, as the value it had in the channel's file
    brainModel: brain === "0" ? "" : brain,
    brainProvider: str(env, "TOPICS_VOICE_BRAIN_PROVIDER"),
    brainEffort: str(env, "TOPICS_VOICE_BRAIN_EFFORT"),
    quickModel: str(env, "TOPICS_VOICE_QUICK_MODEL", DEFAULT_QUICK_MODEL),
    assistant: str(env, "TOPICS_VOICE_ASSISTANT", DEFAULT_ASSISTANT),
    org: str(env, "TOPICS_VOICE_ORG"),
    agentLabel: str(env, "TOPICS_VOICE_AGENT_LABEL"),
    vocabulary: str(env, "TOPICS_VOICE_VOCABULARY")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean),
    timeZone: str(env, "TOPICS_VOICE_TZ"),
    thinkingLevel: str(env, "TOPICS_VOICE_THINKING_LEVEL", "low"),
    speakWhileThinking: str(env, "TOPICS_VOICE_SPEAK_WHILE_THINKING") === "1",
    debug: str(env, "TOPICS_VOICE_DEBUG") === "1",
    scenarios: str(env, "TOPICS_VOICE_SCENARIOS"),
    geminiKey: str(env, "GEMINI_API_KEY"),
    groqKey: str(env, "GROQ_API_KEY"),
  };
}

/** Where the voice keeps its own files (filler cache, recordings): `TOPICS_HOME/voice`. */
export function voiceHome(env: Env = process.env): string {
  return join(str(env, "TOPICS_HOME", join(homedir(), ".topics")), "voice");
}

/** "Saturday 14/11/2026, 18:05" in the configured zone: what the prompts call now. */
export function spokenNow(at: Date, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("it-IT", opts).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("it-IT", { ...opts, timeZone: undefined }).formatToParts(at);
  }
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")}/${p("month")}/${p("year")}, ${p("hour")}:${p("minute")}`;
}
