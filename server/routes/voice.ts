import type { AppContext, RouteHandler } from "../types";
import { transcribe, sttCapabilities, SttError, MAX_STT_BYTES, type SttDeps } from "../lib/stt";

// ElevenLabs voice ids are alphanumeric tokens. Validate before interpolating
// into the API URL so a crafted `voiceId` can't redirect the request (SSRF) or
// exfiltrate the API key via path injection. Reject anything with /, ., ?, %, etc.
const VOICE_ID_RE = /^[A-Za-z0-9]{16,32}$/;
const MAX_TTS_CHARS = 5000;

/** ISO-639-1/3 e basta: questo valore finisce in un campo di richiesta verso terzi. */
const LANG_RE = /^[a-z]{2,3}$/;

/**
 * Voice I/O endpoints — speech-to-text and text-to-speech (ElevenLabs). Split out
 * of the topics router (it was a non-chat concern mixed into a ~4k-LOC god-file).
 * See AUDIT-2026-06-19.md (god-file decomposition).
 *
 * La trascrizione vera vive in `server/lib/stt.ts`: qui resta solo il trasporto
 * HTTP (multipart in, JSON out) più il cancello sulla dimensione. Quel modulo
 * sceglie il provider — ElevenLabs Scribe v2 / OpenAI gpt-transcribe / Deepgram
 * Nova-3 / Groq Whisper turbo / whisper.cpp locale — e scende la cascata da solo.
 */
export function createVoiceRouter(ctx: AppContext, deps: Partial<SttDeps> = {}): RouteHandler {
  const { json, readJSON } = ctx;
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const doFetch = deps.fetchImpl ?? fetch;

  return async function voiceRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- Chi trascriverà, e cosa manca a chi non può ---
    //
    // Il client lo chiede PRIMA di mostrare il tasto della dettatura: senza
    // questa risposta l'unico modo di scoprire che non c'è nessun motore era
    // registrare quaranta secondi e ricevere un errore.
    if (method === "GET" && pathname === "/api/stt/capabilities") {
      return json(sttCapabilities(env));
    }

    // --- La nota vocale VUOTA si registra da sola ---
    //
    // Perche' esiste. Il difetto «il vocale non parte sul telefono» e' rimasto
    // senza diagnosi per giorni per un motivo strutturale: il guasto succede
    // PRIMA della richiesta, quindi il server non ne sapeva niente. Misurato sul
    // log di 300 avvii: 27 `GET /api/stt/capabilities` e ZERO `POST /api/stt`.
    // Il client chiedeva «la trascrizione c'e'?» e non mandava mai audio, e
    // quell'assenza non lascia traccia da nessuna parte.
    //
    // Il messaggio a schermo (`messaggioNotaVuota`) dice la causa a chi sta
    // guardando in quel momento. Su un telefono non c'e' una console, il toast
    // sparisce, e chi lo legge non e' chi ripara. Qui la stessa frase diventa
    // una riga di log sul server, con i due numeri che distinguono i due
    // guasti: il prossimo tentativo, da qualunque dispositivo, lascia la sua
    // causa dove qualcuno la ritrova.
    //
    // NON porta audio e non risponde niente: e' una segnalazione, non un
    // caricamento. Percio' e' innocua anche se qualcuno la chiama a mano.
    if (method === "POST" && pathname === "/api/stt/vuota") {
      let corpo: { spezzoni?: unknown; byte?: unknown; mimeType?: unknown; superficie?: unknown } = {};
      try { corpo = (await req.json()) as typeof corpo; } catch { /* corpo storto: si registra lo stesso */ }
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : -1);
      const testo = (v: unknown) => (typeof v === "string" && v.length <= 80 ? v : "?");
      const ua = req.headers.get("user-agent") ?? "?";
      console.warn(
        `[stt] nota vocale VUOTA: ${n(corpo.spezzoni)} spezzoni, ${n(corpo.byte)} byte, ` +
          `mime ${testo(corpo.mimeType)}, superficie ${testo(corpo.superficie)} · ${ua.slice(0, 120)}`,
      );
      return json({ ok: true });
    }

    // --- STT ---
    if (method === "POST" && pathname === "/api/stt") {
      try {
        const formData = await req.formData();
        const audioFile = formData.get("audio");
        if (!audioFile || typeof audioFile === "string") return json({ error: "audio file required" }, 400);
        const file = audioFile as File;
        if (file.size > MAX_STT_BYTES) {
          return json({ error: `audio troppo grande (max ${MAX_STT_BYTES / 1024 / 1024} MB)` }, 413);
        }

        // La lingua può arrivare dal client (un utente che detta in inglese su un
        // server configurato in italiano), ma resta un suggerimento: `auto` è il
        // default, ed è ciò che i modelli di oggi fanno meglio da soli.
        const langField = formData.get("language");
        const language = typeof langField === "string" && LANG_RE.test(langField.trim().toLowerCase())
          ? langField.trim().toLowerCase()
          : undefined;

        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await transcribe(
          { bytes, filename: file.name || "audio.webm", mimeType: file.type || "audio/webm" },
          { ...deps, env: language ? { ...env, STT_LANGUAGE: language } : env },
        );
        return json(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("STT error:", message);
        // 503 e non 500: «non c'è nessun motore configurato» è uno stato del
        // servizio, e il client lo distingue da un guasto di trascrizione per
        // dire all'umano cosa gli manca invece di «riprova».
        const status = err instanceof SttError && err.attempts.length === 0 ? 503 : 500;
        return json({ error: message }, status);
      }
    }

    // --- TTS (ElevenLabs) ---
    if (method === "POST" && pathname === "/api/tts") {
      const body = await readJSON(req) as { text?: unknown; voiceId?: unknown } | null;
      if (!body?.text || typeof body.text !== "string") return json({ error: "text required" }, 400);
      // Cap the payload so this paid external call can't be driven to run up cost
      // on huge inputs. (Network auth/rate-limit is the deferred security cluster.)
      if (body.text.length > MAX_TTS_CHARS) return json({ error: `text too long (max ${MAX_TTS_CHARS} chars)` }, 400);
      if (!env.ELEVENLABS_API_KEY) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);
      try {
        const voiceId = typeof body.voiceId === "string" && body.voiceId ? body.voiceId : "iP95p4xoKVk53GoZ742B";
        if (!VOICE_ID_RE.test(voiceId)) return json({ error: "invalid voiceId" }, 400);
        const resp = await doFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY || "" },
          body: JSON.stringify({ text: body.text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
        });
        if (!resp.ok) { const errText = await resp.text(); return json({ error: "TTS failed: " + errText }, 502); }
        const audioBuffer = await resp.arrayBuffer();
        return new Response(audioBuffer, { headers: { "Content-Type": "audio/mpeg", "Content-Length": audioBuffer.byteLength.toString() } });
      } catch (err: unknown) { return json({ error: "TTS error: " + (err instanceof Error ? err.message : String(err)) }, 500); }
    }

    return null;
  };
}
