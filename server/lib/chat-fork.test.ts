/**
 * The pure rules of «Fork into a new chat», on literal rows.
 *
 * Where the branch starts (the last finished answer a model said), what the
 * copy is (linear, new ids, no half rows), how the parent's CLI transcript is
 * read, when the CLI's memory would not match the copy, when a spawn forks,
 * and which runtime has a way to carry the memory at all.
 *
 * @covers CHAT-FORK-01, CHAT-FORK-02, CHAT-FORK-03
 */
import { describe, expect, test } from "bun:test";
import { cliForkBlocker, copyThreadForFork, forkPointIndex, forkStartFor, lastMainAssistant, type ForkRow } from "./chat-fork";
import { forkModeFor } from "../../shared/chat-fork";
import type { ContentBlock } from "../../shared/types";

const notice = [{ kind: "background-notice", event: "deferred", change: "model", text: "later" }] as ContentBlock[];
const stop = [{ kind: "machine-stop", cause: "land", text: "stopped" }] as unknown as ContentBlock[];

function turns(n: number): ForkRow[] {
  const rows: ForkRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ id: `u${i}`, role: "user", content: `prompt ${i}`, parentId: i ? `a${i - 1}` : null, branchIndex: 0 });
    rows.push({ id: `a${i}`, role: "assistant", content: `answer ${i}`, parentId: `u${i}`, branchIndex: 0 });
  }
  return rows;
}

describe("forkPointIndex: the last finished answer somebody said", () => {
  test("the last assistant row of a clean thread", () => {
    expect(forkPointIndex(turns(2))).toBe(3);
  });

  test("skips a partial answer and a background notice after it", () => {
    const rows = [...turns(2), { id: "p", role: "assistant", content: "half", partial: true }, { id: "n", role: "assistant", content: "", blocks: notice }];
    expect(forkPointIndex(rows)).toBe(3);
  });

  test("a stop line is the machine's row, not an answer", () => {
    expect(forkPointIndex([...turns(1), { id: "u1", role: "user", content: "go" }, { id: "s", role: "assistant", content: "", blocks: stop }])).toBe(1);
  });

  test("no finished answer yet: -1", () => {
    expect(forkPointIndex([])).toBe(-1);
    expect(forkPointIndex([{ id: "u0", role: "user", content: "hi" }])).toBe(-1);
  });
});

describe("copyThreadForFork", () => {
  test("new ids, the chain rehung on the copy, branch index 0, everything else as it was", () => {
    const rows = turns(2).map((r) => ({ ...r, timestamp: "2026-09-28T10:00:00Z", model: "m" }));
    rows[1] = { ...rows[1], branchIndex: 2 };
    const copy = copyThreadForFork(rows);
    expect(copy.map((r) => r.content)).toEqual(rows.map((r) => r.content));
    expect(copy.some((r) => rows.some((o) => o.id === r.id))).toBe(false);
    expect(copy[0].parentId).toBeNull();
    for (let i = 1; i < copy.length; i++) expect(copy[i].parentId).toBe(copy[i - 1].id);
    expect(copy.every((r) => r.branchIndex === 0)).toBe(true);
    expect(copy.every((r) => r.timestamp === "2026-09-28T10:00:00Z" && r.model === "m")).toBe(true);
  });

  test("a partial row is left out and the chain closes over it", () => {
    const rows: ForkRow[] = [{ id: "u0", role: "user", content: "a" }, { id: "g", role: "assistant", content: "ghost", partial: true }, { id: "a0", role: "assistant", content: "b" }];
    const copy = copyThreadForFork(rows);
    expect(copy.map((r) => r.content)).toEqual(["a", "b"]);
    expect(copy[1].parentId).toBe(copy[0].id);
  });
});

describe("lastMainAssistant: the uuid --resume-session-at takes", () => {
  const line = (o: object) => JSON.stringify(o);

  test("the last assistant line of the main conversation, with its text", () => {
    const jsonl = [
      line({ type: "user", uuid: "x1", message: { content: "hi" } }),
      line({ type: "assistant", uuid: "a1", isSidechain: false, message: { content: [{ type: "text", text: "first" }] } }),
      line({ type: "assistant", uuid: "a2", isSidechain: false, message: { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "second" }] } }),
      line({ type: "assistant", uuid: "sub", isSidechain: true, message: { content: [{ type: "text", text: "sub-agent" }] } }),
      line({ type: "system", uuid: "s1" }),
    ].join("\n");
    expect(lastMainAssistant(jsonl)).toEqual({ uuid: "a2", text: "second" });
  });

  test("a truncated last line is skipped, not fatal", () => {
    const jsonl = line({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "ok" }] } }) + "\n{\"type\":\"assist";
    expect(lastMainAssistant(jsonl)).toEqual({ uuid: "a1", text: "ok" });
  });

  test("no answer: null; a tool-only answer has no text", () => {
    expect(lastMainAssistant(line({ type: "user", uuid: "u" }))).toBeNull();
    expect(lastMainAssistant("")).toBeNull();
    expect(lastMainAssistant(line({ type: "assistant", uuid: "t", message: { content: [{ type: "tool_use", name: "Bash" }] } }))).toEqual({ uuid: "t", text: "" });
  });
});

describe("cliForkBlocker: when the CLI would remember something the copy does not show", () => {
  const clean = turns(2);
  const last = { uuid: "a", text: "answer 1" };

  test("a clean thread whose transcript ends on the same answer forks", () => {
    expect(cliForkBlocker(clean, 3, { last })).toBeNull();
    // The CLI's last line is the answer's final text block: the DB row holds the whole turn.
    expect(cliForkBlocker([...clean.slice(0, 3), { ...clean[3], content: "I ran it.\n\nanswer 1  " }], 3, { last })).toBeNull();
  });

  test("rule 1: an edited or regenerated row up to the point", () => {
    const regenerated = clean.map((r) => (r.id === "a0" ? { ...r, branchIndex: 1 } : r));
    expect(cliForkBlocker(regenerated, 3, { last })).toBe("edited-or-regenerated");
  });

  test("rule 2: after the point only background notices are allowed", () => {
    expect(cliForkBlocker([...clean, { id: "n", role: "assistant", content: "", blocks: notice }], 3, { last })).toBeNull();
    expect(cliForkBlocker([...clean, { id: "p", role: "assistant", content: "", partial: true }], 3, { last })).toBe("rows-after-point");
    expect(cliForkBlocker([...clean, { id: "u", role: "user", content: "unanswered" }], 3, { last })).toBe("rows-after-point");
    expect(cliForkBlocker([...clean, { id: "s", role: "assistant", content: "", blocks: stop }], 3, { last })).toBe("rows-after-point");
  });

  test("rule 3 (Claude Code): the transcript is ahead of the database, or its last answer has no text", () => {
    expect(cliForkBlocker(clean, 3, { last: { uuid: "b", text: "a turn made from the terminal" } })).toBe("transcript-ahead");
    expect(cliForkBlocker(clean, 3, { last: { uuid: "b", text: "" } })).toBe("transcript-without-answer");
    expect(cliForkBlocker(clean, 3, { last: null })).toBe("transcript-without-answer");
  });

  test("Codex has no transcript text to compare: rules 1 and 2 only", () => {
    expect(cliForkBlocker(clean, 3)).toBeNull();
    expect(cliForkBlocker([...clean, { id: "u", role: "user", content: "x" }], 3)).toBe("rows-after-point");
  });
});

describe("forkStartFor: the spawn forks at most once", () => {
  const origin = { runtime: "claude-cli", parentRef: "P", parentAt: "U", branchRef: "C" };

  test("the session IS the minted uuid and its transcript is not there yet: fork", () => {
    expect(forkStartFor(origin, "C", false)).toEqual({ sessionId: "P", atUuid: "U" });
  });

  test("the branch's transcript exists: an ordinary resume", () => {
    expect(forkStartFor(origin, "C", true)).toBeNull();
  });

  test("a forgotten session (a /clear, a reap, a recovery) minted another uuid: never fork again", () => {
    expect(forkStartFor(origin, "D", false)).toBeNull();
  });

  test("no fork pending, another runtime, or not a branch", () => {
    expect(forkStartFor({ ...origin, parentRef: null, parentAt: null }, "C", false)).toBeNull();
    expect(forkStartFor({ ...origin, runtime: "codex-cli" }, "C", false)).toBeNull();
    expect(forkStartFor(null, "C", false)).toBeNull();
  });
});

describe("forkModeFor: every runtime has its way, or no menu item", () => {
  test("the table", () => {
    const names = ["claude-code", "claude-code-team", "codex", "topics", "topics:opus", "claude", "openai", "direct-x", "openclaw", "jcode"];
    expect(names.map(forkModeFor)).toEqual([
      "claude-cli", "claude-cli", "codex-cli", "db-history", "db-history", "db-history", "db-history", "db-history", null, null,
    ]);
    expect(forkModeFor(null)).toBeNull();
  });
});
