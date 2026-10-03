// MSEL-11 measurement: does the native engine's request reach the address in
// ~/.claude/settings.json env.ANTHROPIC_BASE_URL? Throwaway HOME, fake token,
// fake local listener. A fetch guard refuses every non-loopback host, so no
// request can ever leave this machine (no real model call).
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WT = process.argv[2]!;
const received: string[] = [];
const sse = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    received.push(`${req.method} ${new URL(req.url).pathname} auth=${req.headers.get("authorization")?.slice(0, 16)}`);
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});
const home = mkdtempSync(join(tmpdir(), "msel11-home-"));
mkdirSync(join(home, ".claude"), { recursive: true });
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` } }));
writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-throwaway-token", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }));
process.env.HOME = home;
process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
delete process.env.ANTHROPIC_BASE_URL;

const blocked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    blocked.push(url.toString());
    throw new Error(`guard: refused non-loopback ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

const { runAgentTurn } = await import(join(WT, "server/providers/native/agent-loop.ts"));
let outcome = "ok";
try {
  await runAgentTurn(
    { model: "claude-haiku-4-5-20251001", history: [{ role: "user", content: "ping" }], tools: () => [], toolContext: { workspace: home }, signal: AbortSignal.timeout(4000) },
    { onTextDelta() {}, onToolStart() {}, onToolResult() {}, onDone() {}, onError() {} },
  );
} catch (e) { outcome = `error: ${(e as Error).message.slice(0, 160)}`; }
console.log(JSON.stringify({ settingsBaseUrl: `http://127.0.0.1:${server.port}`, listenerReceived: received, blockedNonLoopback: [...new Set(blocked)], outcome }, null, 1));
server.stop(true);
process.exit(0);
