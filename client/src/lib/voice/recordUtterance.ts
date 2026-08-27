/**
 * Records ONE turn of a spoken reply and transcribes it — the same recipe as
 * `useVoiceCall` (microphone, turn end on silence via VAD, `/api/stt`), but
 * as a standalone function instead of a hook: the board's voice controller
 * has no chat to attach to (no `sendMessage`, no `currentMessages`), it just
 * needs "listen and return the text".
 */
import { transcribeAudio, extForMime, pickRecorderMimeType, MIN_VOICE_BLOB_BYTES, SPEECH_AUDIO_CONSTRAINTS, SPEECH_BITS_PER_SECOND } from '../stt';
import { attachSilenceDetector } from '../vad';

export interface RecordUtteranceOptions {
  /** Turn end on silence, in ms. */
  silenceMs?: number;
  /** Hard cap on turn duration, in ms — safety net. */
  maxTurnMs?: number;
  /** No speech within this time: closes without recording anything. */
  noSpeechTimeoutMs?: number;
}

const DEFAULTS: Required<RecordUtteranceOptions> = {
  silenceMs: 1200,
  maxTurnMs: 20_000,
  noSpeechTimeoutMs: 8_000,
};

export function isMicSupported(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Opens the mic, listens for one turn, transcribes it. Empty string = no
 * speech (silence, or the person never replied in time) — not an error: the
 * caller decides whether that counts as a "skip".
 */
export async function recordUtterance(opts: RecordUtteranceOptions = {}): Promise<string> {
  const cfg = { ...DEFAULTS, ...opts };
  if (!isMicSupported()) return '';

  const stream = await navigator.mediaDevices.getUserMedia({ audio: SPEECH_AUDIO_CONSTRAINTS });
  try {
    const mimeType = pickRecorderMimeType();
    const mediaRecorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: SPEECH_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const stopped = new Promise<Blob | null>((resolve) => {
      mediaRecorder.onstop = () => {
        vad.stop();
        if (chunks.length === 0) { resolve(null); return; }
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || mimeType || 'audio/webm' });
        resolve(blob.size >= MIN_VOICE_BLOB_BYTES ? blob : null);
      };
    });

    const closeTurn = () => { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); };
    const vad = attachSilenceDetector(stream, {
      onSilence: closeTurn,
      onMaxDuration: closeTurn,
      onNoSpeech: closeTurn,
      silenceMs: cfg.silenceMs,
      maxTurnMs: cfg.maxTurnMs,
      noSpeechTimeoutMs: cfg.noSpeechTimeoutMs,
    });

    mediaRecorder.start(250);
    const audioBlob = await stopped;
    if (!audioBlob) return '';

    const result = await transcribeAudio(audioBlob, { filename: `voice.${extForMime(audioBlob.type)}` });
    return result.transcript.trim();
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
