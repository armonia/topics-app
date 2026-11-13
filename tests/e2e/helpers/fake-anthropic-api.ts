/**
 * A scripted Anthropic Messages API for the native runtime
 * (`server/providers/native`), so an E2E can run a REAL server turn with a
 * REAL shell while only the model is fake.
 *
 * The runtime finds it through `env.ANTHROPIC_BASE_URL` of the test server's
 * `$HOME/.claude/settings.json` (`server/providers/native/base-url.ts`, read
 * fresh at every call), and needs a credential file next to it to count as
 * connected (`auth.ts`). `installFakeAnthropic` writes both and gives back the
 * function that puts the previous files back.
 *
 * Each prompt carries `SCEN:<name>`; the round is the number of assistant
 * messages after that prompt, so a script is a list of rounds. A round with no
 * script answers `FINE-<name>` and ends the turn.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeTool {
  name: string;
  input: Record<string, unknown>;
  /** Spread the input JSON over this many ms, in 30 pieces: a model writing a long call. */
  argStreamMs?: number;
}
export interface FakeRound {
  text?: string;
  tools?: FakeTool[];
  /** A reasoning block before everything else: its summary, streamed in one delta. */
  thinking?: string;
  /** A `redacted_thinking` block before everything else: no text ever streams for it. */
  redactedThinking?: boolean;
  /** Pause after the reasoning block, before the answer: the reasoning row live alone. */
  afterThinkingMs?: number;
  /** Pause after the last block, before the round ends: the turn live with all its rows. */
  holdMs?: number;
  /**
   * Stream `text` in this many deltas instead of one, `pieceMs` apart: an
   * answer that is half on screen when something happens to the server.
   * Piece `i` (1-based) is `«i»` followed by its slice, so a test can tell
   * which pieces arrived, in which order, and whether any came twice.
   */
  textPieces?: number;
  pieceMs?: number;
}

/** The text a round with `textPieces` streams, piece by piece. */
export function pieceTexts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `«${i + 1}» `);
}

export interface FakeAnthropic {
  baseUrl: string;
  /**
   * Every request served: when, for which scenario and round, the conversation
   * it carried (so a test can read the `tool_result` a round was given) and the
   * ids of the `tool_use` blocks it answered with.
   */
  requests: Array<{ at: number; scen: string; round: number; messages: FakeMessage[]; toolUseIds: string[] }>;
  /** When the last piece of each tool input went out, by tool name and scenario. */
  inputDoneAt: Map<string, number>;
  close(): Promise<void>;
}

export interface FakeMessage { role: string; content: unknown }

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function scenarioOf(messages: Array<{ role: string; content: unknown }>): { scen: string; round: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = typeof m.content === "string"
      ? m.content
      : (Array.isArray(m.content) ? m.content : [])
        .filter((b: { type?: string }) => b.type === "text")
        .map((b: { text?: string }) => b.text ?? "")
        .join("\n");
    const hit = /SCEN:([a-z0-9-]+)/.exec(text);
    if (!hit) continue;
    return { scen: hit[1]!, round: messages.slice(i + 1).filter((x) => x.role === "assistant").length };
  }
  return { scen: "", round: 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeAnthropic(scripts: Record<string, FakeRound[]>): Promise<FakeAnthropic> {
  const requests: FakeAnthropic["requests"] = [];
  const inputDoneAt = new Map<string, number>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let body: { model?: string; messages?: Array<{ role: string; content: unknown }> } = {};
      try { body = JSON.parse(raw); } catch { /* an empty body answers like an unknown scenario */ }
      const { scen, round } = scenarioOf(body.messages ?? []);
      const record = { at: Date.now(), scen, round, messages: body.messages ?? [], toolUseIds: [] as string[] };
      requests.push(record);
      const spec: FakeRound = scripts[scen]?.[round] ?? { text: scen ? `FINE-${scen}` : "ok" };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const write = (s: string) => { try { res.write(s); } catch { /* the client went away */ } };
      write(sse("message_start", { message: { id: `msg_${++n}`, type: "message", role: "assistant", content: [], model: body.model ?? "fake", usage: { input_tokens: 10, output_tokens: 0 } } }));
      let index = 0;
      if (spec.redactedThinking) {
        write(sse("content_block_start", { index, content_block: { type: "redacted_thinking", data: "e2e-encrypted" } }));
        write(sse("content_block_stop", { index }));
        index++;
      }
      if (spec.thinking) {
        write(sse("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }));
        write(sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: spec.thinking } }));
        write(sse("content_block_delta", { index, delta: { type: "signature_delta", signature: "e2e-signature" } }));
        write(sse("content_block_stop", { index }));
        index++;
      }
      if (spec.afterThinkingMs) await sleep(spec.afterThinkingMs);
      if (spec.textPieces) {
        write(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
        for (const piece of pieceTexts(spec.textPieces)) {
          write(sse("content_block_delta", { index, delta: { type: "text_delta", text: piece } }));
          await sleep(spec.pieceMs ?? 300);
        }
        write(sse("content_block_stop", { index }));
        index++;
      } else if (spec.text) {
        write(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
        write(sse("content_block_delta", { index, delta: { type: "text_delta", text: spec.text } }));
        write(sse("content_block_stop", { index }));
        index++;
      }
      for (const t of spec.tools ?? []) {
        const id = `toolu_${scen}_${round}_${index}_${n}`;
        record.toolUseIds.push(id);
        write(sse("content_block_start", { index, content_block: { type: "tool_use", id, name: t.name, input: {} } }));
        const json = JSON.stringify(t.input);
        const pieces = t.argStreamMs ? 30 : 1;
        const size = Math.ceil(json.length / pieces);
        for (let p = 0; p < pieces; p++) {
          write(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(p * size, (p + 1) * size) } }));
          if (t.argStreamMs) await sleep(t.argStreamMs / pieces);
        }
        inputDoneAt.set(`${scen}:${t.name}:${index}`, Date.now());
        write(sse("content_block_stop", { index }));
        index++;
      }
      if (spec.holdMs) await sleep(spec.holdMs);
      write(sse("message_delta", { delta: { stop_reason: spec.tools?.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } }));
      write(sse("message_stop", {}));
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    inputDoneAt,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * THE UNDO THAT NEVER RAN. `installFakeAnthropic` is undone by the spec's
 * `afterAll`, and a job cancelled or killed mid-spec never gets there. On a
 * runner whose `/tmp` outlives the job (the permanent node) the fake credential
 * stays in the test HOME, the native runtime reads as connected, and every
 * later chat without a pinned runtime goes to it and waits on a dead port:
 * four reds on 13/11 in specs that never touch the engine. The global setup
 * calls this before the server starts. Only what this file writes is taken
 * away: the token it names and the loopback base URL it set.
 */
export function removeStaleFakeAnthropic(home: string): void {
  const dir = join(home, ".claude");
  const credentials = join(dir, ".credentials.json");
  try {
    if (readFileSync(credentials, "utf8").includes(FAKE_ACCESS_TOKEN)) rmSync(credentials, { force: true });
  } catch { /* no file: nothing left over */ }
  const settingsPath = join(dir, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: Record<string, unknown> };
    const url = settings.env?.ANTHROPIC_BASE_URL;
    if (typeof url === "string" && /^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
      delete settings.env!.ANTHROPIC_BASE_URL;
      writeFileSync(settingsPath, JSON.stringify(settings));
    }
  } catch { /* no file or not JSON: nothing of ours */ }
}

const FAKE_ACCESS_TOKEN = "e2e-fake-access";

/**
 * Points the test server's native runtime at `baseUrl` with a fake credential.
 * The Keychain is off on the test server (`TOPICS_CREDENTIALS_KEYCHAIN=0` in
 * `testServerEnv`), so the fake file is the only credential it can find, and
 * its far expiry means no refresh is ever attempted. Returns the undo.
 */
export function installFakeAnthropic(home: string, baseUrl: string): () => void {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  // Merged, not replaced: whatever else the server keeps there stays readable.
  let settings: { env?: Record<string, unknown> } = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* no file yet */ }
  const files = {
    [settingsPath]: JSON.stringify({ ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: baseUrl } }),
    [join(dir, ".credentials.json")]: JSON.stringify({
      claudeAiOauth: {
        accessToken: FAKE_ACCESS_TOKEN,
        refreshToken: "e2e-fake-refresh",
        expiresAt: 4_102_444_800_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
  };
  const previous = new Map<string, string | null>();
  for (const [path, content] of Object.entries(files)) {
    previous.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
    writeFileSync(path, content);
  }
  return () => {
    for (const [path, content] of previous) {
      if (content === null) rmSync(path, { force: true });
      else writeFileSync(path, content);
    }
  };
}
