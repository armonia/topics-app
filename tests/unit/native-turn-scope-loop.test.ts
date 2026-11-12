/**
 * The scope reaches the loop (card 7be32c03): a turn that creates a file in its
 * workspace may remove it in a LATER call, and a file it only found there is
 * still refused, with the same message as before.
 *
 * Driven against a fake `fetch` like `agent-loop-hooks.test.ts`: each scripted
 * round asks for one tool call, the last closes the turn. The workspace sits
 * OUTSIDE every temp root, so the temp rule cannot be what lets the `rm` pass.
 *
 * @covers RT-07
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn, type AgentMessage } from "../../server/providers/native/agent-loop";
import type { RetryPolicy } from "../../server/providers/native/retry";
import type { StreamHandler } from "../../server/providers/types";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
const FAST: RetryPolicy = { maxAttempts: 2, baseMs: 1, capMs: 2, jitter: () => 1 };

let credsHome: string;
let root: string;
let ws: string;

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function toolRound(id: string, name: string, input: Record<string, unknown>): string {
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ]);
}

const lastRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

/** Run one turn whose model asks for exactly these tool calls, in order; returns what each answered. */
async function turn(calls: Array<[string, Record<string, unknown>]>): Promise<Array<{ text: string; isError: boolean }>> {
  const results: Array<{ text: string; isError: boolean }> = [];
  const rounds = [...calls.map(([name, input], i) => toolRound(`t${i}`, name, input)), lastRound];
  let n = 0;
  globalThis.fetch = (async () => new Response(rounds[Math.min(n++, rounds.length - 1)]!, { status: 200 })) as unknown as typeof fetch;
  const handler: StreamHandler = {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: (_id, text, isError) => { results.push({ text, isError: !!isError }); },
    onDone: () => {},
    onError: (e: string) => { throw new Error(e); },
    onAborted: () => {},
  };
  const history: AgentMessage[] = [{ role: "user", content: "ripulisci" }];
  await runAgentTurn(
    { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
    handler,
  );
  return results;
}

beforeAll(() => {
  credsHome = mkdtempSync(join(tmpdir(), "native-scope-home-"));
  mkdirSync(join(credsHome, ".claude"), { recursive: true });
  writeFileSync(
    join(credsHome, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "token-A", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
  );
  process.env.HOME = credsHome;
  // After the HOME switch, `homedir()` follows it: build the workspace under the REAL home.
  mkdirSync(join(REAL_HOME ?? homedir(), ".cache"), { recursive: true });
  root = mkdtempSync(join(REAL_HOME ?? homedir(), ".cache", "topics-turn-scope-loop-"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  rmSync(credsHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  ws = mkdtempSync(join(root, "ws-"));
});

describe("the loop gives the turn its own files back", () => {
  test("a file made by an earlier call is removed by a later one; a file found there is refused", async () => {
    writeFileSync(join(ws, "found.txt"), "was here first");
    const r = await turn([
      ["bash", { command: "cat > made.sh <<'EOF'\necho hi\nEOF" }],
      ["bash", { command: "rm -f made.sh" }],
      ["bash", { command: "rm -f found.txt" }],
    ]);
    expect(r[0]).toMatchObject({ isError: false });
    expect(r[1]).toMatchObject({ isError: false });
    expect(existsSync(join(ws, "made.sh"))).toBe(false);
    expect(r[2]!.isError).toBe(true);
    expect(r[2]!.text).toContain("Comando bloccato (rm ricorsivo o forzato)");
    expect(existsSync(join(ws, "found.txt"))).toBe(true);
  });

  test("a file made with write_file", async () => {
    const r = await turn([
      ["write_file", { path: "note.md", content: "x" }],
      ["bash", { command: "rm -f note.md" }],
    ]);
    expect(r.map((x) => x.isError)).toEqual([false, false]);
    expect(existsSync(join(ws, "note.md"))).toBe(false);
  });

  test("a folder made in the turn is removed with what a script put inside it", async () => {
    const r = await turn([
      ["bash", { command: "mkdir out" }],
      ["bash", { command: `python3 -c "open('out/from-script.txt','w').write('x')"` }],
      ["bash", { command: "rm -rf out" }],
    ]);
    expect(r.map((x) => x.isError)).toEqual([false, false, false]);
    expect(existsSync(join(ws, "out"))).toBe(false);
  });

  test("a file a script made at the top level is not the registry's: refused, as before", async () => {
    const r = await turn([
      ["bash", { command: `python3 -c "open('from-script.txt','w').write('x')"` }],
      ["bash", { command: "rm -f from-script.txt" }],
    ]);
    expect(r[1]!.isError).toBe(true);
    expect(existsSync(join(ws, "from-script.txt"))).toBe(true);
  });

  test("a registry belongs to ONE turn: the next turn finds the file as somebody else's", async () => {
    await turn([["bash", { command: "touch yesterday.txt" }]]);
    const r = await turn([["bash", { command: "rm -f yesterday.txt" }]]);
    expect(r[0]!.isError).toBe(true);
    expect(existsSync(join(ws, "yesterday.txt"))).toBe(true);
  });

  test("a refused call creates nothing the registry would remember", async () => {
    const r = await turn([
      // An absolute path under the REAL home: `~` follows the HOME switch above, into temp.
      ["bash", { command: `rm -rf ${REAL_HOME}/never-existing-dir-7be32c03 && touch made-after-refusal.txt` }],
      ["bash", { command: "rm -f made-after-refusal.txt" }],
    ]);
    expect(r[0]!.isError).toBe(true);
    expect(r[1]!.isError).toBe(true);
    expect(existsSync(join(ws, "made-after-refusal.txt"))).toBe(false);
  });
});
