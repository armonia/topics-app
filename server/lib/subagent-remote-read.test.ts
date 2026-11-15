/**
 * @covers SUBAGENT-27
 */
import { describe, it, expect } from "bun:test";
import { readRemoteChild, type ReadRemoteChildInput } from "./subagent-remote-read";

type Comment = { id: string; content: string; createdAt: string };

// A node that answers `since` the way `node-client.ts#readRun` documents: every comment AT or after it.
function nodeWith(comments: Comment[]): ReadRemoteChildInput["readRun"] {
  return async ({ since }) => ({ comments: comments.filter((c) => !since || c.createdAt >= since) });
}

const base = { machineId: "node-1", runId: "run-1", baseUrlOf: () => "https://node.local", tokenOf: () => "tok" };

describe("readRemoteChild", () => {
  it("una seconda lettura col cursore non ripete i commenti, nemmeno quelli dello stesso istante", async () => {
    const comments: Comment[] = [
      { id: "a", content: "uno", createdAt: "2026-11-15T10:00:00.000Z" },
      { id: "b", content: "due", createdAt: "2026-11-15T10:00:01.000Z" },
      { id: "c", content: "tre", createdAt: "2026-11-15T10:00:01.000Z" },
    ];
    const first = await readRemoteChild({ ...base, readRun: nodeWith(comments) });
    expect(first.ok && first.events.map((e) => e.text)).toEqual(["uno", "due", "tre"]);

    const again = await readRemoteChild({ ...base, since: first.ok ? first.nextOffset : "", readRun: nodeWith(comments) });
    expect(again.ok && again.events).toEqual([]);

    comments.push({ id: "d", content: "quattro", createdAt: "2026-11-15T10:00:01.000Z" });
    const later = await readRemoteChild({ ...base, since: again.ok ? again.nextOffset : "", readRun: nodeWith(comments) });
    expect(later.ok && later.events.map((e) => e.text)).toEqual(["quattro"]);
  });

  it("nodo che non risponde: ok false col motivo, nessuna eccezione", async () => {
    const result = await readRemoteChild({ ...base, readRun: async () => { throw new Error("unreachable"); } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unreachable");
  });
});
