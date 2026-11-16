/**
 * @covers SUBAGENT-27
 */
import { describe, it, expect } from "bun:test";
import { emptyRemoteChildLog, readRemoteChild, type ReadRemoteChildInput } from "./subagent-remote-read";

type Comment = { id: string; content: string; createdAt: string };

// A paired Topics: every comment AT or after `since`, as `node-client.ts#readRun` documents.
function pairedNode(comments: Comment[]): ReadRemoteChildInput["readRun"] {
  return async ({ since }) => ({ comments: comments.filter((c) => !since || c.createdAt >= since) });
}

const base = { machineId: "node-1", runId: "run-1", baseUrlOf: () => "https://node.local", tokenOf: () => "tok" };

describe("readRemoteChild", () => {
  it("una seconda lettura non ripete i commenti, nemmeno quelli dello stesso istante", async () => {
    const comments: Comment[] = [
      { id: "a", content: "uno", createdAt: "2026-11-15T10:00:00.000Z" },
      { id: "b", content: "due", createdAt: "2026-11-15T10:00:01.000Z" },
      { id: "c", content: "tre", createdAt: "2026-11-15T10:00:01.000Z" },
    ];
    const log = emptyRemoteChildLog();
    const first = await readRemoteChild({ ...base, log, since: 0, readRun: pairedNode(comments) });
    expect(first).toEqual({ ok: true, events: ["uno", "due", "tre"].map((text) => ({ type: "assistant", text })), nextOffset: 3, source: "node" });

    const again = await readRemoteChild({ ...base, log, since: 3, readRun: pairedNode(comments) });
    expect(again.ok && again.events).toEqual([]);

    comments.push({ id: "d", content: "quattro", createdAt: "2026-11-15T10:00:01.000Z" });
    const later = await readRemoteChild({ ...base, log, since: 3, readRun: pairedNode(comments) });
    expect(later.ok && later.events.map((e) => e.text)).toEqual(["quattro"]);
    expect(later.ok && later.nextOffset).toBe(4);
  });

  it("nodo cloud che rimette lo stesso commento con un orario nuovo a ogni lettura: arriva una volta sola", async () => {
    let reads = 0;
    const cloud: ReadRemoteChildInput["readRun"] = async () => {
      reads += 1;
      return { comments: [{ id: "ask-1", content: "serve un permesso", createdAt: new Date(Date.UTC(2026, 10, 15, 10, 0, reads)).toISOString() }] };
    };
    const log = emptyRemoteChildLog();
    const first = await readRemoteChild({ ...base, log, since: 0, readRun: cloud });
    const second = await readRemoteChild({ ...base, log, since: first.ok ? first.nextOffset : 0, readRun: cloud });
    expect(first.ok && first.events.map((e) => e.text)).toEqual(["serve un permesso"]);
    expect(second.ok && second.events).toEqual([]);
  });

  it("dopo un riavvio il log riparte vuoto: un since oltre la fine rilegge da capo invece di perdere", async () => {
    const reborn = emptyRemoteChildLog();
    const comments = [
      { id: "x", content: "pendente", createdAt: "2026-11-15T11:00:00.000Z" },
      { id: "y", content: "consegna", createdAt: "2026-11-15T11:00:01.000Z" },
    ];
    const result = await readRemoteChild({ ...base, log: reborn, since: 5, readRun: pairedNode(comments) });
    expect(result.ok && result.events.map((e) => e.text)).toEqual(["pendente", "consegna"]);
    expect(result.ok && result.nextOffset).toBe(2);
  });

  it("nodo che non risponde: ok false col motivo, nessuna eccezione", async () => {
    const result = await readRemoteChild({ ...base, log: emptyRemoteChildLog(), since: 0, readRun: async () => { throw new Error("unreachable"); } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unreachable");
  });
});

describe("readRemoteChild keeps only the child's own voice", () => {
  it("drops the node's bookkeeping, keeps the agent on a paired node and on the cloud", async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 13, 41, s)).toISOString();
    const comments = [
      { id: "1", author: "system", kind: "service", content: "Card specchiata da …", createdAt: at(0) },
      { id: "2", author: "dispatcher", kind: "status", content: "todo→in_progress", createdAt: at(1) },
      { id: "3", author: "agent:7de6", kind: "comment", content: "working on it", createdAt: at(2) },
      { id: "4", author: "agent:7de6", kind: "delivery", content: "Added note-1.txt", createdAt: at(3) },
      { id: "5", author: "agent:7de6", kind: "status", content: "in_progress→review", createdAt: at(4) },
      { id: "6", author: "user", kind: "comment", content: "archived while the agent worked", createdAt: at(5) },
      { id: "7", author: "agent", kind: "delivery", content: "cloud result", createdAt: at(6) },
    ];
    const r = await readRemoteChild({ ...base, log: emptyRemoteChildLog(), since: 0, readRun: async () => ({ comments }) });
    expect(r.ok && r.events.map((e) => e.text)).toEqual(["working on it", "Added note-1.txt", "cloud result"]);
  });

  it("a node that sends no author keeps every line, as before", async () => {
    const r = await readRemoteChild({ ...base, log: emptyRemoteChildLog(), since: 0, readRun: pairedNode([{ id: "a", content: "uno", createdAt: "2026-11-16T10:00:00.000Z" }]) });
    expect(r.ok && r.events.map((e) => e.text)).toEqual(["uno"]);
  });
});
