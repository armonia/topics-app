/**
 * @covers TITLE-02
 */
import { describe, expect, test } from "bun:test";
import { extractCodexTitleFromRollout } from "../../server/lib/codex-transcript-title";

const jline = (o: unknown) => JSON.stringify(o);
const userMsg = (message: string) =>
  jline({ type: "event_msg", payload: { type: "user_message", message } });
const meta = (id = "abc") =>
  jline({ type: "session_meta", payload: { id, cwd: "/x", originator: "codex-tui" } });

describe("extractCodexTitleFromRollout", () => {
  test("prefers the LAST clean user_message (current turn)", () => {
    const raw = [
      meta(),
      userMsg("set up the project"),
      jline({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
      userMsg("fix the login bug"),
    ].join("\n");
    expect(extractCodexTitleFromRollout(raw)).toBe("fix the login bug");
  });

  test("falls back to the first user_message when only one exists", () => {
    const raw = [meta(), userMsg("deploy the staging server")].join("\n");
    expect(extractCodexTitleFromRollout(raw)).toBe("deploy the staging server");
  });

  test("ignores the response_item representation, uses event_msg", () => {
    // The response_item form carries the <environment_context> preamble as its
    // first user message; only the event_msg/user_message is the clean prompt.
    const raw = [
      meta(),
      jline({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd=/x</environment_context>" }] } }),
      userMsg("mi generi un pdf"),
    ].join("\n");
    expect(extractCodexTitleFromRollout(raw)).toBe("mi generi un pdf");
  });

  test("skips harness markup ('<', '#', guardian preamble), keeps the real prompt", () => {
    const raw = [
      meta(),
      userMsg("aiutami col deploy"),
      userMsg("<environment_context>noise</environment_context>"),
      userMsg("# internal guidance line"),
      userMsg("The following is the Codex agent history and should be ignored"),
    ].join("\n");
    expect(extractCodexTitleFromRollout(raw)).toBe("aiutami col deploy");
  });

  test("first REAL user message wins over an earlier markup one", () => {
    const raw = [
      meta(),
      userMsg("<environment_context>cwd</environment_context>"),
      userMsg("build the reel factory"),
    ].join("\n");
    expect(extractCodexTitleFromRollout(raw)).toBe("build the reel factory");
  });

  test("collapses whitespace and truncates to 80 chars", () => {
    const long = "a".repeat(200);
    const raw = [meta(), userMsg(`  line one\n\tline   two ${long}`)].join("\n");
    const out = extractCodexTitleFromRollout(raw)!;
    expect(out.length).toBe(80);
    expect(out.startsWith("line one line two")).toBe(true);
    expect(out).not.toContain("\n");
  });

  test("returns null for meta-only / unusable rollouts", () => {
    expect(extractCodexTitleFromRollout("")).toBeNull();
    expect(extractCodexTitleFromRollout(meta())).toBeNull();
    expect(extractCodexTitleFromRollout("not json\n{garbage")).toBeNull();
    expect(extractCodexTitleFromRollout(userMsg("   "))).toBeNull();
  });

  test("ignores malformed lines but still finds a valid title", () => {
    const raw = ["{ broken json", "", meta(), userMsg("survived the noise")].join("\n");
    expect(extractCodexTitleFromRollout(raw)).toBe("survived the noise");
  });
});

// ─── Incremental file-backed derivation ─────────────────────────────────────
import { deriveCodexSessionTitle } from "../../server/lib/codex-transcript-title";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("deriveCodexSessionTitle (incremental)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-title-"));
  let n = 0;
  const freshFile = () => join(dir, `r-${n++}.jsonl`);

  test("an appended user_message updates the derived title across calls", () => {
    const f = freshFile();
    writeFileSync(f, meta() + "\n" + userMsg("first prompt") + "\n");
    expect(deriveCodexSessionTitle(f)).toBe("first prompt");
    appendFileSync(f, userMsg("second prompt") + "\n");
    expect(deriveCodexSessionTitle(f)).toBe("second prompt");
  });

  test("unterminated final line is used opportunistically, not consumed", () => {
    const f = freshFile();
    writeFileSync(f, meta() + "\n" + userMsg("committed") + "\n" + userMsg("tail without newline"));
    expect(deriveCodexSessionTitle(f)).toBe("tail without newline");
    appendFileSync(f, "\n" + userMsg("final") + "\n");
    expect(deriveCodexSessionTitle(f)).toBe("final");
  });

  test("a shrunken (rotated) file rescans from zero", () => {
    const f = freshFile();
    writeFileSync(f, meta() + "\n" + userMsg("long old content padding padding") + "\n");
    expect(deriveCodexSessionTitle(f)).toBe("long old content padding padding");
    writeFileSync(f, meta() + "\n" + userMsg("rotated") + "\n");
    expect(deriveCodexSessionTitle(f)).toBe("rotated");
  });

  test("missing file → null", () => {
    expect(deriveCodexSessionTitle(join(dir, "nope.jsonl"))).toBeNull();
  });
});
