/**
 * @covers TITLE-02
 */
import { describe, expect, test } from "bun:test";

const jline = (o: unknown) => JSON.stringify(o);
const userMsg = (message: string) =>
  jline({ type: "event_msg", payload: { type: "user_message", message } });
const meta = (id = "abc") =>
  jline({ type: "session_meta", payload: { id, cwd: "/x", originator: "codex-tui" } });

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
