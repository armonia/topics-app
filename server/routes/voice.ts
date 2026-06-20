import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

// ElevenLabs voice ids are alphanumeric tokens. Validate before interpolating
// into the API URL so a crafted `voiceId` can't redirect the request (SSRF) or
// exfiltrate the API key via path injection. Reject anything with /, ., ?, %, etc.
const VOICE_ID_RE = /^[A-Za-z0-9]{16,32}$/;
const MAX_TTS_CHARS = 5000;

/**
 * Voice I/O endpoints — speech-to-text (Whisper, local) and text-to-speech
 * (ElevenLabs). Split out of the topics router (it was a non-chat concern mixed
 * into a ~4k-LOC god-file). Self-contained: only `ctx.json` / `ctx.readJSON`,
 * stdlib + external CLIs/HTTP. See AUDIT-2026-06-19.md (god-file decomposition).
 */
export function createVoiceRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;

  return async function voiceRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- STT (Whisper, local) ---
    if (method === "POST" && pathname === "/api/stt") {
      // Per-request temp dir with an unpredictable name (mkdtemp) instead of a
      // guessable /tmp/stt-<Date.now()> path — closes the symlink/TOCTOU window.
      let tmpDir: string | null = null;
      try {
        const formData = await req.formData();
        const audioFile = formData.get("audio");
        if (!audioFile || typeof audioFile === "string") return json({ error: "audio file required" }, 400);
        tmpDir = mkdtempSync(join(tmpdir(), "stt-"));
        const tempWebm = join(tmpDir, "in.webm");
        const tempWav = join(tmpDir, "out.wav");
        const buffer = await (audioFile as File).arrayBuffer();
        writeFileSync(tempWebm, Buffer.from(buffer));
        const ffmpeg = Bun.spawnSync(["ffmpeg", "-i", tempWebm, "-ar", "16000", "-ac", "1", tempWav, "-y"], { timeout: 30000, stdout: "pipe", stderr: "pipe" });
        if (ffmpeg.exitCode !== 0) throw new Error(`ffmpeg conversion failed: ${ffmpeg.stderr.toString()}`);
        const whisperModel = process.env.WHISPER_MODEL_PATH || `${process.env.HOME || ""}/whisper-models/ggml-large-v3.bin`;
        const whisper = Bun.spawnSync(["whisper-cli", "-m", whisperModel, "-l", "it", "-f", tempWav, "--no-timestamps"], { timeout: 60000, stdout: "pipe", stderr: "pipe" });
        if (whisper.exitCode !== 0) throw new Error(`Whisper failed: ${whisper.stderr.toString()}`);
        const transcript = whisper.stdout.toString().split("\n").filter((line: string) => !line.match(/^(whisper|ggml|system|main):/i) && line.trim()).join(" ").trim();
        return json({ transcript });
      } catch (err: any) {
        console.error("STT error:", err);
        return json({ error: "STT failed: " + err.message }, 500);
      } finally {
        if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
      }
    }

    // --- TTS (ElevenLabs) ---
    if (method === "POST" && pathname === "/api/tts") {
      const body = await readJSON(req);
      if (!body?.text || typeof body.text !== "string") return json({ error: "text required" }, 400);
      // Cap the payload so this paid external call can't be driven to run up cost
      // on huge inputs. (Network auth/rate-limit is the deferred security cluster.)
      if (body.text.length > MAX_TTS_CHARS) return json({ error: `text too long (max ${MAX_TTS_CHARS} chars)` }, 400);
      if (!process.env.ELEVENLABS_API_KEY) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);
      try {
        const voiceId = body.voiceId || "iP95p4xoKVk53GoZ742B";
        if (!VOICE_ID_RE.test(voiceId)) return json({ error: "invalid voiceId" }, 400);
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY || "" },
          body: JSON.stringify({ text: body.text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
        });
        if (!resp.ok) { const errText = await resp.text(); return json({ error: "TTS failed: " + errText }, 502); }
        const audioBuffer = await resp.arrayBuffer();
        return new Response(audioBuffer, { headers: { "Content-Type": "audio/mpeg", "Content-Length": audioBuffer.byteLength.toString() } });
      } catch (err: any) { return json({ error: "TTS error: " + err.message }, 500); }
    }

    return null;
  };
}
