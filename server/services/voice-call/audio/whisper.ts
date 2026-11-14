/**
 * Whisper (large-v3-turbo on Groq, free, ~0.4 s) on one phrase of the call:
 * the second opinion on what Gemini heard. Ported from the `whisper` and
 * `whisper_raw` functions of jarvis-channels `natural.rs`, with `fetch` in place
 * of a curl child so a test can stand in for Groq.
 */
import { whisperNoise, wav16k } from "./natural";

export const WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const WHISPER_MODEL = "whisper-large-v3-turbo";
const WHISPER_TIMEOUT_MS = 4000;

/** What a call needs to ask whisper: a key and, in tests, a fake fetch. */
export interface WhisperDeps {
  key: string;
  fetchImpl?: typeof fetch;
  /** the language of the call, as whisper wants it ("it") */
  language?: string;
}

/**
 * The transcript of the segments whisper is sure of. Not null = whisper
 * answered (maybe with an empty text); null = whisper did not answer.
 */
async function whisperRaw(deps: WhisperDeps, pcm: ArrayLike<number>): Promise<string | null> {
  const form = new FormData();
  form.set("model", WHISPER_MODEL);
  form.set("language", deps.language ?? "it");
  form.set("response_format", "verbose_json");
  form.set("file", new Blob([wav16k(pcm)], { type: "audio/wav" }), "phrase.wav");
  try {
    const res = await (deps.fetchImpl ?? fetch)(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.key}` },
      body: form,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });
    const v = (await res.json()) as { segments?: { text?: string; no_speech_prob?: number; avg_logprob?: number }[] };
    if (!Array.isArray(v.segments)) return null;
    const text = v.segments
      .filter((s) => (s.no_speech_prob ?? 0) < 0.5 && (s.avg_logprob ?? 0) > -1)
      .map((s) => s.text)
      .filter((t): t is string => typeof t === "string")
      .join(" ");
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Whisper on a phrase, PCM at 16 kHz. `{ok: true, text: null}` = no words
 * (music, noise); `{ok: false}` = whisper did not answer.
 */
export async function whisper(deps: WhisperDeps, pcm: ArrayLike<number>): Promise<{ ok: true; text: string | null } | { ok: false }> {
  const raw = await whisperRaw(deps, pcm);
  if (raw === null) return { ok: false };
  return { ok: true, text: raw !== "" && !whisperNoise(raw) ? raw : null };
}
