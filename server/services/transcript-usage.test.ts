/**
 * @covers USAGE-15
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptUsageReader, ZERO_USAGE } from "./transcript-usage";

function usageLine(opts: {
  id?: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  model?: string;
}): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        id: opts.id ?? "msg_x",
        model: opts.model ?? "claude-sonnet-5",
        usage: {
          input_tokens: opts.input ?? 0,
          output_tokens: opts.output ?? 0,
          cache_creation_input_tokens: opts.cacheWrite ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
        },
      },
    }) + "\n"
  );
}

describe("transcript-usage reader", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcript-usage-"));
    path = join(dir, "session.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns zeros for a missing transcript", () => {
    const r = createTranscriptUsageReader();
    expect(r.read(join(dir, "nope.jsonl"))).toEqual(ZERO_USAGE);
  });

  it("counts a usage row once per message.id (content-block duplicates collapse)", () => {
    // Claude Code writes one usage line PER CONTENT BLOCK of the same API
    // response — identical usage, same message.id. The old sum overcounted 2.4x.
    writeFileSync(
      path,
      usageLine({ id: "msg_1", input: 10, output: 20, cacheWrite: 100, cacheRead: 1000 }) +
        usageLine({ id: "msg_1", input: 10, output: 20, cacheWrite: 100, cacheRead: 1000 }) +
        usageLine({ id: "msg_1", input: 10, output: 20, cacheWrite: 100, cacheRead: 1000 }) +
        usageLine({ id: "msg_2", input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }),
    );
    const r = createTranscriptUsageReader();
    const u = r.read(path);
    expect(u.inputTokens).toBe(11);
    expect(u.outputTokens).toBe(22);
    expect(u.cacheWriteTokens).toBe(103);
    expect(u.cacheReadTokens).toBe(1004);
    expect(u.billableTokens).toBe(11 + 22 + 103);
  });

  it("ignores non-usage lines and lines where 'usage' is not message usage", () => {
    writeFileSync(
      path,
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: 'blob with "usage" inside' }] } }) + "\n" +
        "not json at all\n" +
        usageLine({ id: "msg_1", input: 5, output: 5 }),
    );
    const r = createTranscriptUsageReader();
    const u = r.read(path);
    expect(u.billableTokens).toBe(10);
  });

  it("reads incrementally: appended rows add, prior bytes are not re-read", () => {
    writeFileSync(path, usageLine({ id: "msg_1", input: 100 }));
    const r = createTranscriptUsageReader();
    expect(r.read(path).inputTokens).toBe(100);

    appendFileSync(path, usageLine({ id: "msg_2", input: 50 }));
    expect(r.read(path).inputTokens).toBe(150);
    // Same size, no new bytes → same totals (idempotent poll).
    expect(r.read(path).inputTokens).toBe(150);
  });

  it("buffers a line written in two chunks (mid-write poll)", () => {
    const full = usageLine({ id: "msg_1", input: 7, output: 9 });
    const cut = Math.floor(full.length / 2);
    writeFileSync(path, full.slice(0, cut));
    const r = createTranscriptUsageReader();
    expect(r.read(path).billableTokens).toBe(0); // half a line = nothing yet

    appendFileSync(path, full.slice(cut));
    expect(r.read(path).billableTokens).toBe(16);
  });

  it("survives a multi-byte char split across poll boundaries", () => {
    // Task text with accents can land in a usage row's message; splitting the
    // file read mid-char must not corrupt the line (partial is kept as bytes).
    const line = usageLine({ id: "msg_à_1", input: 3 });
    const bytes = Buffer.from(line, "utf8");
    const accentAt = bytes.indexOf(0xc3); // first byte of a 2-byte UTF-8 char
    writeFileSync(path, bytes.subarray(0, accentAt + 1));
    const r = createTranscriptUsageReader();
    expect(r.read(path).inputTokens).toBe(0);
    appendFileSync(path, bytes.subarray(accentAt + 1));
    expect(r.read(path).inputTokens).toBe(3);
  });

  it("resets and recounts when the file shrinks (transcript replaced)", () => {
    writeFileSync(path, usageLine({ id: "msg_1", input: 1000 }) + usageLine({ id: "msg_2", input: 1000 }));
    const r = createTranscriptUsageReader();
    expect(r.read(path).inputTokens).toBe(2000);

    // Replaced with a smaller file (e.g. compaction): totals start over.
    writeFileSync(path, usageLine({ id: "msg_9", input: 42 }));
    expect(r.read(path).inputTokens).toBe(42);
  });

  it("dedups across incremental reads (same id appended later)", () => {
    writeFileSync(path, usageLine({ id: "msg_1", input: 10 }));
    const r = createTranscriptUsageReader();
    expect(r.read(path).inputTokens).toBe(10);
    appendFileSync(path, usageLine({ id: "msg_1", input: 10 }));
    expect(r.read(path).inputTokens).toBe(10); // duplicate block row, not new spend
  });
});
