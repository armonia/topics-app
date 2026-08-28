/**
 * A ROUND THAT DIES HALFWAY MUST NOT COME BACK AS "FINISHED NORMALLY".
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `runAgentTurn` read `stop_reason` for one value only, `max_tokens`;
 * everything else - `null` included - left through `onDone` as
 * `{end: "end_turn"}`. And `null` is exactly what a round carries when the SSE
 * body ends without a `message_delta`: the stream died while the model was
 * writing a tool call. Reported as a natural end, that turn got no notice in
 * chat and no retry from the dispatcher. It just stopped, quietly.
 *
 * The tell is the one already used for a truncated call: `tool_use` blocks
 * present, and a round that did NOT close with `tool_use`. The turn was
 * interrupted, whatever the reason.
 *
 * Driven here against a fake SSE stream, like `round-usage.test.ts` next door:
 * no network, no real credentials, and the interesting case (a body that ends
 * mid-call) is a string instead of a provider outage to wait for.
 * @covers CHAT-REL-03
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";

const HOME_VERA = process.env.HOME;
let homeDir: string;
let ws: string;
const realFetch = globalThis.fetch;

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * The measured shape: the model announces a tool, starts writing its
 * arguments, and the body ENDS. No `content_block_stop`, no `message_delta`,
 * so `stopReason` stays `null`.
 */
const cutRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.md","content":"# tit' } },
]);

/** Same cut, but the round had already closed the call: `stop_reason` is there. */
const cutRoundAfterTheCall = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_2", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.md"}' } },
  { type: "content_block_stop", index: 0 },
]);

/** The output cap cut the call: a different sentence, and an honest one. */
const roundCutByTheCap = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_3", name: "write_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.md","content":"# tit' } },
  { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8000 } },
]);

/** A healthy end: prose, no tool blocks, `end_turn`. */
const healthyRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

/** A turn that says nothing at all and ends: still a natural end. */
const muteRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
]);

interface Ledger {
  done: number;
  errors: string[];
  asks: Array<{ toolCallId: string; toolName: string; kind: string }>;
}

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onUserInputRequired: (toolCallId, toolName, schema) => {
      reg.asks.push({ toolCallId, toolName, kind: (schema as { kind: string }).kind });
    },
    onToolResult: () => {},
    onDone: () => { reg.done++; },
    onError: (e: string) => { reg.errors.push(e); },
  };
}

async function turn(...bodies: string[]) {
  // One body per ROUND, the last one repeating. A round that ends with
  // `tool_use` sends the loop back for another, so a single body would replay
  // the same round until the loop's own cap.
  let n = 0;
  globalThis.fetch = (async () => {
    const body = bodies[Math.min(n++, bodies.length - 1)]!;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const reg: Ledger = { done: 0, errors: [], asks: [] };
  const history: AgentMessage[] = [{ role: "user", content: "scrivi un file" }];
  const out = await runAgentTurn(
    { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply" },
    handler(reg),
  );
  return { out, reg };
}

describe("il giro che muore a meta' non e' una fine naturale", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-cut-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-cut-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "finto-ma-fresco", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = homeDir;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("stop_reason assente e una chiamata a strumenti aperta: la fine NON e' end_turn", async () => {
    const { out, reg } = await turn(cutRound);
    expect(out.turnEnd.end).not.toBe("end_turn");
    expect(out.turnEnd.end).toBe("error");
    expect(out.turnEnd.cause).toBe("provider-error");
    // And it leaves through the right door: `onError` makes the route write a
    // notice, `onDone` does not. That door is where the turn died in silence.
    expect(reg.errors.length).toBe(1);
    expect(reg.done).toBe(0);
  });

  test("stessa fine anche se la chiamata era gia' chiusa: quel che conta e' che il giro non si sia chiuso con tool_use", async () => {
    const { out } = await turn(cutRoundAfterTheCall);
    expect(out.turnEnd.end).toBe("error");
  });

  test("il tetto dei token resta max_tokens: il taglio ha una ragione, e si dice quella", async () => {
    const { out, reg } = await turn(roundCutByTheCap);
    expect(out.turnEnd.end).toBe("max_tokens");
    expect(reg.done).toBe(1);
  });

  test("un turn sano finisce end_turn, e nessuno lo tocca", async () => {
    const { out, reg } = await turn(healthyRound);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(out.text).toBe("fatto");
    expect(reg.done).toBe(1);
    expect(reg.errors).toEqual([]);
  });

  test("un turn che non produce nemmeno una parola, ma si chiude, resta end_turn", async () => {
    const { out } = await turn(muteRound);
    expect(out.turnEnd.end).toBe("end_turn");
  });

  describe("una domanda all'umano si vede a schermo", () => {
    /**
     * THE PANEL IS RENDERED FROM THIS SIGNAL, not from the answer channel: the
     * `/api/sessions/:key/ask-user` route says so in its own comment, it only
     * carries the reply back. The CLI provider has always emitted it; this
     * runtime never did, so on 2026-08-28 a chat sat on a `running` ask with the
     * question in the database and nothing on screen to answer it. The turn
     * cannot end and nobody can unblock it.
     */
    test("il ciclo nativo chiede l'input PRIMA di eseguire il tool che blocca", async () => {
      const { reg } = await turn(askRound, healthyRound);
      expect(reg.asks.length).toBe(1);
      expect(reg.asks[0]!.toolName).toBe("ask_user_question");
      expect(reg.asks[0]!.toolCallId).toBe("tu_ask");
      // `questions`, not the `raw` fallback: the human gets buttons, not a blob.
      expect(reg.asks[0]!.kind).toBe("questions");
    });

    test("un tool qualunque non apre nessun pannello", async () => {
      const { reg } = await turn(healthyRound);
      expect(reg.asks.length).toBe(0);
    });
  });
});
/**
 * A round in which the model asks the HUMAN, using the bare name the native
 * runtime gives the tool (it imports the Topics handlers straight from
 * `mcp/topics-mcp-server`, so there is no fleet prefix).
 */
const askRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_ask", name: "ask_user_question", input: {} } },
  {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "input_json_delta",
      partial_json: '{"questions":[{"header":"Doc","question":"Come procediamo?","options":[{"label":"A","description":"a"},{"label":"B","description":"b"}]}]}',
    },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
]);
