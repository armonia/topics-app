/**
 * The native runtime gets the language directive in its SYSTEM prompt, every
 * turn. Before, the chat route passed this runtime no system prompt at all:
 * the directive only rode inline in the user turn, the inline dedup dropped it
 * after the first turn, and the history rebuilt from the DB never had it.
 * On 04/10 topic:d740f8ae (an Italian chat on the native runtime) answered in
 * English, following Topics' own notices.
 *
 * Drives the REAL provider against a stubbed API and reads what it sent.
 * @covers PROMPT-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider, nativeSystemPrompt } from "./provider";
import { languageDirective, languageReminder } from "../../lib/topics-agent-prompt";
import type { StreamHandler } from "../types";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let home: string;
let workspace: string;

const answer = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const quiet: StreamHandler = { onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {} };

/** The text of every system block of each request the provider sent. */
async function systemsSent(sessionKey: string, messages: string[]): Promise<string[]> {
  const sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: Array<{ text: string }> };
    sent.push((body.system ?? []).map((b) => b.text).join("\n"));
    return new Response(answer, { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
  for (const m of messages) await provider.sendChat(sessionKey, m, quiet);
  return sent;
}

describe("the native runtime's system prompt carries the language", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "native-lang-home-"));
    workspace = mkdtempSync(join(tmpdir(), "native-lang-ws-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = home;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    for (const d of [home, workspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("every turn, not only the first: an English notice later does not lose it", async () => {
    const sent = await systemsSent("topic:lang-probe", ["ciao, lavora sul livello", "Objective still open: the level"]);
    expect(sent.length).toBe(2);
    for (const system of sent) expect(system).toContain(languageDirective());
  });

  test("the person's message ends with the language reminder, an English notice included", async () => {
    const lasts: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: Array<{ text?: string }> }> };
      lasts.push(body.messages.at(-1)!.content.at(-1)!.text);
      return new Response(answer, { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
    await provider.sendChat("topic:lang-reminder", "Command `build` finished: exit 0 after 3m.", quiet);
    expect(lasts).toEqual([languageReminder()]);
  });

  test("the reminder follows the setting, one short line", () => {
    expect(languageReminder("it")).toBe("<system-reminder>Rispondi in italiano.</system-reminder>");
    expect(languageReminder("en")).toBe("<system-reminder>Answer in English.</system-reminder>");
    expect(languageReminder("auto")).toContain("the language the person writes in");
  });

  test("the pure composition: base, the no-workspace note only without a project, the language last", () => {
    const it = languageDirective("it");
    expect(nativeSystemPrompt({ base: "B", workspace: true, globalOrchestrator: false, language: it })).toBe(`B\n\n${it}`);
    expect(nativeSystemPrompt({ workspace: false, globalOrchestrator: false, language: it })).toContain("non ha un progetto collegato");
    expect(nativeSystemPrompt({ workspace: false, globalOrchestrator: true, language: it })).toBe(it);
  });
});
