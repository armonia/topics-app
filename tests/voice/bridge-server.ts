#!/usr/bin/env bun
/**
 * A server with only the voice bridge on it, for the bench: the same
 * `VoiceBridgeSession` that server.ts mounts on `/ws/voice/bridge`, without the
 * rest of Topics, so the bench never touches a live server or its database.
 *
 *   TOPICS_HOME=<scratch> GEMINI_API_KEY=… GROQ_API_KEY=… \
 *   TOPICS_VOICE_BRAIN_MODEL=<model> ANTHROPIC_API_KEY=… [ANTHROPIC_BASE_URL=…] \
 *   bun run tests/voice/bridge-server.ts [--port 13334]
 *
 * The brain runs on the direct Claude provider of Topics when a model and an
 * Anthropic key are set (the base URL is the SDK's own variable); otherwise
 * Gemini thinks alone.
 */
import { ClaudeProvider } from "../../server/providers/claude";
import { VOICE_BRIDGE_PATH, VoiceBridgeSession } from "../../server/services/voice-call/bridge";
import type { Complete } from "../../server/services/voice-call/brain";
import { voiceHome, voiceSettings } from "../../server/services/voice-call/config";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("--port") ?? process.env.PORT ?? 13334);
if (port === 3333) throw new Error("the bench never runs on the live port");

// the scenarios are separate calls of the same person a minute apart, not call backs
process.env.TOPICS_VOICE_RESUME_MIN ??= "0";
const settings = voiceSettings();
const key = process.env.ANTHROPIC_API_KEY ?? "";
let complete: Complete | null = null;
if (settings.brainModel && key) {
  const claude = new ClaudeProvider({ type: "claude", apiKey: key, model: settings.brainModel, maxTokens: 1200 });
  claude.start();
  complete = (messages, options) => claude.complete(messages, options);
}

type Data = { voice?: VoiceBridgeSession };

Bun.serve<Data>({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname !== VOICE_BRIDGE_PATH) return new Response("Not Found", { status: 404 });
    return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) {
      ws.data.voice = new VoiceBridgeSession(
        { send: (d) => void ws.send(d), close: (c, r) => ws.close(c, r), bufferedAmount: () => ws.getBufferedAmount() },
        { settings, complete: () => complete },
      );
    },
    message(ws, m) {
      if (typeof m === "string") ws.data.voice?.onText(m);
      else ws.data.voice?.onBinary(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
    },
    close(ws) {
      ws.data.voice?.onClose();
    },
  },
});

console.log(
  `voice bridge on ws://127.0.0.1:${port}${VOICE_BRIDGE_PATH} · home ${voiceHome()} · live ${settings.model} · brain ${complete ? settings.brainModel : "off"} · quick ${settings.groqKey ? settings.quickModel : "off"}`,
);
