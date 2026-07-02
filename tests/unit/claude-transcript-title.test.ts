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
