/**
 * The words while you say them, instead of after.
 *
 * WHY IT EXISTS. Dictation in Topics was batch: press, speak, let go, wait.
 * Even when the round trip is quick (650-800 ms on a 5 s clip with Scribe v2,
 * measured on 2026-09-04) there are two seconds in which nothing happens on
 * screen, and whoever dictates a long sentence has no way of noticing that the
 * microphone heard «git ribes» until they have stopped talking.
 *
 * Scribe v2 Realtime sends `partial_transcript` while you speak and
 * `committed_transcript` once a segment is stable. The socket is opened by the
 * CLIENT: it is the side that holds the microphone, and routing the audio
 * through the server would add a hop to every 250 ms packet. The key must never
 * reach here though, so the permission to connect is a single-use token that
 * the server asks for (`POST /api/stt/realtime-token`).
 *
 * THIS MODULE KNOWS NOTHING ABOUT THE MICROPHONE. It receives already sampled
 * Float32 blocks, produced by the level probe of the audio module on the very
 * same AudioContext, and packs them into base64 16 bit PCM. Whoever uses it
 * keeps recording with the `MediaRecorder` in parallel: if this road dies
 * halfway, the audio for the batch flow is already there, whole.
 */

import type { SttRealtimeToken } from '../../../shared/stt';

const REALTIME_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/**
 * The formats the socket accepts. The list answers one question only: did the
 * audio context really give us the rate we asked for? An AudioContext may
 * answer with its native one (48 kHz is the common case), and declaring 16 kHz
 * over 48 kHz samples means transcribing a tape running at three times speed:
 * real words, all of them wrong.
 */
const AUDIO_FORMAT_BY_RATE: Record<number, string> = {
  8000: 'pcm_8000',
  16000: 'pcm_16000',
  22050: 'pcm_22050',
  24000: 'pcm_24000',
  44100: 'pcm_44100',
  48000: 'pcm_48000',
};

/**
 * How many samples pile up before a send. 4096 at 16 kHz are 256 ms: few
 * enough for the first partial to arrive within the second, many enough not to
 * turn a dictation into two hundred messages a second (the worklet hands over
 * blocks of 128 samples, which is 8 ms).
 */
const CHUNK_SAMPLES = 4096;

/** Past this with no `session_started`, the connection counts as dead. */
const SESSION_START_TIMEOUT_MS = 5_000;

/**
 * How long the last `committed_transcript` is waited for after the stop. The
 * final segment arrives right after the commit; past this the socket closes
 * anyway, because holding the strip open waiting for a tail that never comes is
 * the defect realtime was meant to remove, not to add.
 */
const FINAL_COMMIT_WAIT_MS = 2_500;

export interface RealtimeSession {
  /** A mono block of float samples, at the rate declared when opening. */
  send(frame: Float32Array): void;
  /** Closes the running segment, waits for its text, then closes the socket. */
  finish(): Promise<void>;
  /** Closes at once with no commit: a cancel does not pay for a transcription. */
  abort(): void;
  /** How many segments were committed: zero is what makes batch take over. */
  committedCount(): number;
}

export interface RealtimeOptions {
  /** ISO-639-1 to hint the model. Absent = automatic detection. */
  language?: string;
  /** The REAL rate of the audio context producing the blocks. */
  sampleRate: number;
  /** Provisional text: it changes, it is shown in grey and it is not pasted. */
  onPartial(text: string): void;
  /** Stable segment: this one is pasted, and it will not move again. */
  onCommitted(text: string): void;
  /**
   * The socket died mid-sentence (network, quota, key). Called ONCE only:
   * whoever listens goes back to the batch flow with the audio it already has.
   */
  onFail(reason: string): void;
}

/** The shape of the messages coming back, cut down to what is used. */
interface ScribeMessage {
  message_type?: string;
  text?: string;
  error?: string;
  warning?: string;
}

/**
 * `null` when realtime is not on offer: the server says no (key not verified,
 * another engine at the head of the chain), the browser has no WebSocket, or
 * the audio context runs at a rate the service does not accept. It is not an
 * error to show: it is the dictation of before.
 */
export async function startRealtimeDictation(opts: RealtimeOptions): Promise<RealtimeSession | null> {
  if (typeof WebSocket === 'undefined') return null;
  const audioFormat = AUDIO_FORMAT_BY_RATE[opts.sampleRate];
  if (!audioFormat) return null;

  const grant = await fetchRealtimeToken();
  if (!grant) return null;

  const params = new URLSearchParams({
    model_id: grant.model,
    token: grant.token,
    audio_format: audioFormat,
    commit_strategy: 'vad',
  });
  const language = opts.language ?? grant.language ?? '';
  if (language) params.set('language_code', language);

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${REALTIME_URL}?${params.toString()}`);
  } catch {
    return null;
  }

  const pending: number[] = [];
  let committed = 0;
  let dead = false;
  let started = false;
  let onFinalCommit: (() => void) | null = null;

  // A FAILURE BEFORE THE START IS NOT WORTH TELLING. Until `session_started`
  // has arrived this function has returned nothing yet, and the refusal is said
  // with a `null`: the caller stays on batch without anyone reading a line
  // about a socket that never transcribed anything. Afterwards the strip was
  // lit on realtime, and a change of engine has to be said.
  const die = (reason: string) => {
    if (dead) return;
    dead = true;
    onFinalCommit?.();
    onFinalCommit = null;
    try { socket.close(); } catch { /* already closed: nothing to do */ }
    if (started) opts.onFail(reason);
  };

  const flush = (commit: boolean) => {
    if (dead || socket.readyState !== WebSocket.OPEN) return;
    if (pending.length === 0 && !commit) return;
    const samples = Int16Array.from(pending);
    pending.length = 0;
    socket.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: base64FromPcm(samples),
      commit,
      sample_rate: opts.sampleRate,
    }));
  };

  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let msg: ScribeMessage;
    try { msg = JSON.parse(event.data) as ScribeMessage; } catch { return; }
    switch (msg.message_type) {
      case 'session_started':
        started = true;
        break;
      case 'partial_transcript':
        if (msg.text) opts.onPartial(msg.text);
        break;
      case 'committed_transcript': {
        const text = (msg.text ?? '').trim();
        if (text) { committed++; opts.onCommitted(text); }
        // The stop waits for THIS: the final segment, not a fixed delay.
        onFinalCommit?.();
        onFinalCommit = null;
        break;
      }
      // Every `*_error` type, plus the refusals that are not named so: quota
      // spent, terms not accepted, session too long. They all end up in the
      // same place, which is the batch flow: what changes is the diagnostic
      // line, not what happens to the person who is speaking.
      default:
        if (msg.error) die(`${msg.message_type ?? 'error'}: ${msg.error}`);
        break;
    }
  };

  socket.onerror = () => die('websocket error');
  socket.onclose = (event: CloseEvent) => {
    if (dead) return;
    dead = true;
    onFinalCommit?.();
    onFinalCommit = null;
    // A close AFTER the final commit is the normal end of a session.
    if (started && committed === 0) opts.onFail(`socket closed (${event.code})`);
  };

  const open = await waitForOpen(socket);
  if (!open) { try { socket.close(); } catch { /* idem */ } return null; }

  // An open socket is not a session yet: without `session_started` the service
  // has not accepted the token, and the samples would go nowhere.
  const sessionStarted = await waitFor(() => started || dead, SESSION_START_TIMEOUT_MS);
  if (!sessionStarted || dead) { try { socket.close(); } catch { /* idem */ } return null; }

  return {
    send(frame: Float32Array) {
      if (dead || socket.readyState !== WebSocket.OPEN) return;
      for (let i = 0; i < frame.length; i++) {
        const clamped = Math.max(-1, Math.min(1, frame[i]));
        pending.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      }
      if (pending.length >= CHUNK_SAMPLES) flush(false);
    },
    async finish() {
      if (dead) return;
      const last = new Promise<void>((resolve) => { onFinalCommit = resolve; });
      flush(true);
      await Promise.race([last, delay(FINAL_COMMIT_WAIT_MS)]);
      dead = true;
      try { socket.close(); } catch { /* idem */ }
    },
    abort() {
      dead = true;
      pending.length = 0;
      try { socket.close(); } catch { /* idem */ }
    },
    committedCount: () => committed,
  };
}

/**
 * The permission to connect. `null` on any answer that is not a token: the 503
 * («not on offer») and the 502 («I tried and it broke») lead to the same place,
 * which is the batch dictation of before.
 */
async function fetchRealtimeToken(): Promise<SttRealtimeToken | null> {
  try {
    const resp = await fetch('/api/stt/realtime-token', { method: 'POST', credentials: 'same-origin' });
    if (!resp.ok) return null;
    const body = (await resp.json()) as SttRealtimeToken;
    return typeof body?.token === 'string' && body.token ? body : null;
  } catch {
    return null;
  }
}

/** Little-endian 16 bit PCM in base64, in slices: `fromCharCode` with eight
 *  thousand arguments blows the stack. */
function base64FromPcm(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if the socket opened in time, false if it died or was too slow. */
function waitForOpen(socket: WebSocket): Promise<boolean> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    socket.addEventListener('open', () => done(true), { once: true });
    socket.addEventListener('close', () => done(false), { once: true });
    socket.addEventListener('error', () => done(false), { once: true });
    setTimeout(() => done(socket.readyState === WebSocket.OPEN), SESSION_START_TIMEOUT_MS);
  });
}

/** Waits for a condition to become true, checking it at short intervals. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(20);
  }
  return condition();
}
