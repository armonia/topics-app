// ─── Dictating while you speak: the single-use token ─────────────────────────
//
// The cascade in `stt.ts` is BATCH: record, stop, wait. Fine for a voice note,
// not for dictating. The standard of a dictation app is seeing the words appear
// while you say them.
//
// ElevenLabs Scribe v2 Realtime does it over a WebSocket, and the socket is
// opened by the CLIENT: it is the side holding the microphone, and passing the
// audio through the server would add a hop to every 250 ms packet. But the key
// must never reach the browser, so the server stays in the loop for one thing
// only: asking for a single-use token, good for 15 minutes and consumed on
// connect. That single job is this file.
//
// The condition for offering realtime at all lives next to the cascade it reads
// (`realtimeSttReason` in `stt.ts`, which `sttCapabilities` also answers with):
// announcing realtime and then falling back to batch with the microphone open
// is the very defect verified capabilities exist to remove.

import {
  keyRejectedReason,
  languageHint,
  markKeyRejected,
  realtimeSttReason,
  verifyProviderKeys,
  type SttDeps,
} from "./stt";
import type { SttRealtimeToken } from "../../shared/stt";

/** The streaming model: an id of its own, not an option of `scribe_v2`. */
export const REALTIME_MODEL = "scribe_v2_realtime";
/** Mono PCM at 16 kHz: the format the socket accepts and the client produces. */
export const REALTIME_SAMPLE_RATE = 16_000;
export const REALTIME_AUDIO_FORMAT = "pcm_16000";

const REALTIME_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const REALTIME_TOKEN_TIMEOUT_MS = 10_000;

/**
 * An HTTP status travels with the message: the client tells «not on offer»
 * (503, stay on batch, say nothing) apart from «it broke» (502, worth a line
 * in the notice), and neither of the two is an error the person has to read.
 */
export class SttRealtimeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SttRealtimeError";
  }
}

/**
 * The single-use token for the client. It asks for key verification first: a
 * rejected key has to answer «not available» BEFORE spending a call, and a 401
 * met here marks it for every other callsite.
 */
export async function realtimeSttToken(
  env: SttDeps["env"],
  deps: Pick<SttDeps, "fetchImpl"> = {},
): Promise<SttRealtimeToken> {
  const doFetch = deps.fetchImpl ?? fetch;
  await verifyProviderKeys(env, doFetch);
  const reason = realtimeSttReason(env);
  if (reason) throw new SttRealtimeError(reason, 503);

  const key = env.ELEVENLABS_API_KEY!.trim();
  let resp: Response;
  try {
    resp = await doFetch(REALTIME_TOKEN_URL, {
      method: "POST",
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(REALTIME_TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SttRealtimeError(`ElevenLabs unreachable: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  if (resp.status === 401 || resp.status === 403) {
    markKeyRejected("elevenlabs", env, resp.status);
    throw new SttRealtimeError(keyRejectedReason(resp.status), 503);
  }
  if (!resp.ok) throw new SttRealtimeError(`realtime token refused (HTTP ${resp.status})`, 502);

  const body = (await resp.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || !body.token) {
    throw new SttRealtimeError("ElevenLabs answered with no token", 502);
  }
  return {
    token: body.token,
    model: REALTIME_MODEL,
    sampleRate: REALTIME_SAMPLE_RATE,
    audioFormat: REALTIME_AUDIO_FORMAT,
    language: languageHint(env),
  };
}
