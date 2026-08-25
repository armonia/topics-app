/**
 * @covers TITLE-01
 */
import { describe, expect, test } from "bun:test";
import { extractTitleFromTranscript } from "../../server/lib/claude-transcript-title";

const jline = (o: unknown) => JSON.stringify(o);

describe("extractTitleFromTranscript", () => {
  test("prefers the LAST ai-title (the evolving session topic)", () => {
    const raw = [
      jline({ type: "user", message: { role: "user", content: "help me with X" } }),
      jline({ type: "ai-title", aiTitle: "First guess" }),
      jline({ type: "assistant", message: {} }),
      jline({ type: "ai-title", aiTitle: "Fix the login bug" }),
    ].join("\n");
    expect(extractTitleFromTranscript(raw)).toBe("Fix the login bug");
  });

  test("falls back to last-prompt when no ai-title yet", () => {
    const raw = [
      jline({ type: "user", message: { role: "user", content: "first message" } }),
      jline({ type: "last-prompt", lastPrompt: "deploy the staging server" }),
    ].join("\n");
    expect(extractTitleFromTranscript(raw)).toBe("deploy the staging server");
  });

  test("falls back to the first user message when neither ai-title nor last-prompt", () => {
    const raw = [
      jline({ type: "user", message: { role: "user", content: "set up the database schema" } }),
      jline({ type: "user", message: { role: "user", content: "second prompt" } }),
    ].join("\n");
    expect(extractTitleFromTranscript(raw)).toBe("set up the database schema");
  });

  test("handles array-form user content blocks", () => {
    const raw = jline({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "array prompt" }, { type: "text", text: "part two" }] },
    });
    expect(extractTitleFromTranscript(raw)).toBe("array prompt part two");
  });

  test("collapses whitespace and truncates to 80 chars", () => {
    const long = "a".repeat(200);
    const raw = jline({ type: "ai-title", aiTitle: `  line one\n\tline   two ${long}` });
    const out = extractTitleFromTranscript(raw)!;
    expect(out.length).toBe(80);
    expect(out.startsWith("line one line two")).toBe(true);
    expect(out).not.toContain("\n");
  });

  test("returns null for empty / unusable transcripts", () => {
    expect(extractTitleFromTranscript("")).toBeNull();
    expect(extractTitleFromTranscript("not json\n{garbage")).toBeNull();
    expect(extractTitleFromTranscript(jline({ type: "assistant", message: {} }))).toBeNull();
    expect(extractTitleFromTranscript(jline({ type: "ai-title", aiTitle: "   " }))).toBeNull();
  });

  test("ignores malformed lines but still finds a valid title", () => {
    const raw = [
      "{ broken json",
      "",
      jline({ type: "ai-title", aiTitle: "Survived the noise" }),
    ].join("\n");
    expect(extractTitleFromTranscript(raw)).toBe("Survived the noise");
  });
});

// ─── Incremental file-backed derivation ─────────────────────────────────────
// deriveClaudeSessionTitle re-reads ONLY appended bytes across calls (per-path
// scan cache) — these tests exercise growth, unterminated tails, a multibyte
// char split across the delta boundary, and truncation reset.
import { deriveClaudeSessionTitle } from "../../server/lib/claude-transcript-title";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("deriveClaudeSessionTitle (incremental)", () => {
  const dir = mkdtempSync(join(tmpdir(), "title-scan-"));
  let n = 0;
  const freshFile = () => join(dir, `t-${n++}.jsonl`);

  test("appended ai-title updates the derived title across calls", () => {
    const f = freshFile();
    writeFileSync(f, jline({ type: "ai-title", aiTitle: "First topic" }) + "\n");
    expect(deriveClaudeSessionTitle(f)).toBe("First topic");
    appendFileSync(f, jline({ type: "ai-title", aiTitle: "Evolved topic" }) + "\n");
    expect(deriveClaudeSessionTitle(f)).toBe("Evolved topic");
  });

  test("unterminated final line is used opportunistically, not consumed", () => {
    const f = freshFile();
    writeFileSync(f, jline({ type: "ai-title", aiTitle: "Committed" }) + "\n"
      + jline({ type: "ai-title", aiTitle: "Tail without newline" }));
    expect(deriveClaudeSessionTitle(f)).toBe("Tail without newline");
    // The tail line later completes with more data after its newline.
    appendFileSync(f, "\n" + jline({ type: "ai-title", aiTitle: "Final" }) + "\n");
    expect(deriveClaudeSessionTitle(f)).toBe("Final");
  });

  test("multibyte char split across the delta boundary survives", () => {
    const f = freshFile();
    const line = Buffer.from(jline({ type: "ai-title", aiTitle: "cafè età più" }) + "\n", "utf-8");
    const cut = line.indexOf(Buffer.from("è", "utf-8")[0]!, 30) + 1; // mid-'è'
    writeFileSync(f, line.subarray(0, cut));
    deriveClaudeSessionTitle(f); // partial write — must not corrupt state
    appendFileSync(f, line.subarray(cut));
    expect(deriveClaudeSessionTitle(f)).toBe("cafè età più");
  });

  test("a shrunken (rotated) file rescans from zero", () => {
    const f = freshFile();
    writeFileSync(f, jline({ type: "ai-title", aiTitle: "Long old content padding padding" }) + "\n");
    expect(deriveClaudeSessionTitle(f)).toBe("Long old content padding padding");
    writeFileSync(f, jline({ type: "ai-title", aiTitle: "Rotated" }) + "\n");
    expect(deriveClaudeSessionTitle(f)).toBe("Rotated");
  });

  test("missing file → null", () => {
    expect(deriveClaudeSessionTitle(join(dir, "nope.jsonl"))).toBeNull();
  });
});

describe("harness markup never becomes a title", () => {
  test("slash-command last-prompt is skipped, previous prompt kept", () => {
    const raw = [
      jline({ type: "last-prompt", lastPrompt: "fix the sidebar resize" }),
      jline({ type: "last-prompt", lastPrompt: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" }),
    ].join("\n");
    expect(extractTitleFromTranscript(raw)).toBe("fix the sidebar resize");
  });

  test("markup-only transcript yields null, not '<command-name>…'", () => {
    const raw = jline({ type: "user", message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } });
    expect(extractTitleFromTranscript(raw)).toBeNull();
  });

  test("first REAL user message wins over an earlier markup one", () => {
    const raw = [
      jline({ type: "user", message: { role: "user", content: "<command-name>/goal</command-name>" } }),
      jline({ type: "user", message: { role: "user", content: "aiutami col deploy" } }),
    ].join("\n");
    expect(extractTitleFromTranscript(raw)).toBe("aiutami col deploy");
  });
});
