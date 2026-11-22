/**
 * @covers TITLE-01
 */
import { describe, expect, test } from "bun:test";

const jline = (o: unknown) => JSON.stringify(o);

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

