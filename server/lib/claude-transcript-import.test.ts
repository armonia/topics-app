/**
 * @covers EXTSESS-08
 */
import { describe, test, expect } from "bun:test";
import { parseTranscriptToMessages, parseTranscriptDelta } from "./claude-transcript-import";

const line = (o: object) => JSON.stringify(o);

describe("parseTranscriptToMessages", () => {
  test("reconstructs a user→assistant turn with text", () => {
    const text = [
      line({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "ciao" } }),
      line({
        type: "assistant",
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "salve" }] },
      }),
    ].join("\n");
    const msgs = parseTranscriptToMessages(text);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "ciao"],
      ["assistant", "salve"],
    ]);
    // linear chain: assistant's parent is the user message
    expect(msgs[1]!.parentId).toBe(msgs[0]!.id);
    expect(msgs[0]!.parentId).toBeNull();
  });

  test("captures thinking and tool_use, then matches the tool_result", () => {
    const text = [
      line({ type: "user", message: { role: "user", content: "leggi il file" } }),
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "devo leggere" },
            { type: "text", text: "ok" },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
        },
      }),
    ].join("\n");
    const msgs = parseTranscriptToMessages(text);
    // the tool_result-only user line does NOT become a message
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const a = msgs[1]!;
    expect(a.thinking).toBe("devo leggere");
    expect(a.content).toBe("ok");
    expect(a.toolCalls).toHaveLength(1);
    expect(a.toolCalls![0]).toMatchObject({ id: "t1", name: "Read", status: "success", result: "file contents" });
    expect(a.toolCalls![0]!.args).toEqual({ path: "/a" });
  });

  test("marks an errored tool_result", () => {
    const text = [
      line({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] },
      }),
      line({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "boom", is_error: true }] },
      }),
    ].join("\n");
    const msgs = parseTranscriptToMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.toolCalls![0]).toMatchObject({ status: "error", error: "boom" });
  });

  test("drops sidechains, meta lines, non-message types and blank lines", () => {
    const text = [
      "",
      "not json",
      line({ type: "summary", summary: "x" }),
      line({ type: "file-history-snapshot" }),
      line({ type: "user", isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } }),
      line({ type: "user", message: { role: "user", content: "vero" } }),
    ].join("\n");
    const msgs = parseTranscriptToMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("vero");
  });

  test("handles string assistant content and skips empty turns", () => {
    const text = [
      line({ type: "assistant", message: { role: "assistant", content: "plain" } }),
      line({ type: "assistant", message: { role: "assistant", content: [] } }),
      line({ type: "user", message: { role: "user", content: "   " } }),
    ].join("\n");
    const msgs = parseTranscriptToMessages(text);
    expect(msgs.map((m) => m.content)).toEqual(["plain"]);
  });
});

describe("parseTranscriptDelta", () => {
  test("chains the first new message from the given parentId", () => {
    const text = [
      line({ type: "user", message: { role: "user", content: "nuovo turno" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "risposta" }] } }),
    ].join("\n");
    const { messages, resolutions } = parseTranscriptDelta(text, { parentId: "PARENT-99" });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // first new message links to the last already-saved row...
    expect(messages[0]!.parentId).toBe("PARENT-99");
    // ...and the rest stay a linear chain within the delta.
    expect(messages[1]!.parentId).toBe(messages[0]!.id);
    expect(resolutions).toEqual([]);
  });

  test("no parentId ⇒ first message roots at null (full-import parity)", () => {
    const text = line({ type: "user", message: { role: "user", content: "primo" } });
    const { messages } = parseTranscriptDelta(text);
    expect(messages[0]!.parentId).toBeNull();
  });

  test("a tool_result whose tool_use is in the SAME chunk resolves in place", () => {
    const text = [
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    ].join("\n");
    const { messages, resolutions } = parseTranscriptDelta(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.toolCalls![0]).toMatchObject({ id: "t1", status: "success", result: "ok" });
    // in-chunk ⇒ nothing for the caller to patch
    expect(resolutions).toEqual([]);
  });

  test("cross-chunk: tool_use in chunk N, tool_result in chunk N+1", () => {
    // Chunk N — the assistant fires a tool; its result has not landed yet.
    const chunkN = line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "eseguo" }, { type: "tool_use", id: "t7", name: "Bash", input: { command: "sleep 5" } }] },
    });
    const a = parseTranscriptDelta(chunkN, { parentId: "P0" });
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]!.toolCalls![0]).toMatchObject({ id: "t7", name: "Bash" });
    expect(a.messages[0]!.toolCalls![0]!.result).toBeUndefined();
    expect(a.resolutions).toEqual([]);

    // Chunk N+1 — the result arrives on its own. No new message; the caller
    // must patch the saved row that owns t7.
    const chunkN1 = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t7", content: "done" }] } });
    const b = parseTranscriptDelta(chunkN1, { parentId: a.messages[0]!.id });
    expect(b.messages).toEqual([]);
    expect(b.resolutions).toEqual([{ toolUseId: "t7", result: "done", isError: false }]);
  });

  test("cross-chunk error tool_result is flagged", () => {
    const chunkN1 = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "boom", is_error: true }] } });
    const { messages, resolutions } = parseTranscriptDelta(chunkN1, { parentId: "X" });
    expect(messages).toEqual([]);
    expect(resolutions).toEqual([{ toolUseId: "t9", result: "boom", isError: true }]);
  });
});
