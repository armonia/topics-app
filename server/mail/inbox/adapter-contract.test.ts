/**
 * @covers MAIL-01 MAIL-02
 * ONE SERIES OF CHECKS, TWO ADAPTERS: the scripted one and the Gmail reference adapter on recorded
 * `gws` answers (the mail inbox change, track E1: the adapter contract).
 */
import { describe, expect, test } from "bun:test";
import { parseListResponse, type ListAdapter } from "./contract";
import { createGmailList, type GwsCall } from "./gmail-adapter";
import { message, scriptedAdapter } from "./inbox-test-support";

const T1 = "2026-11-28T09:00:00.000Z";
const T2 = "2026-11-28T09:10:00.000Z";
const T3 = "2026-11-28T09:20:00.000Z";
const BEFORE_ALL = Date.parse("2026-11-28T00:00:00.000Z");
const AFTER_ALL = Date.parse("2026-11-28T12:00:00.000Z");

/** What the provider holds, as the contract sees it. */
const SEED = [
  message("m1", T1, { from: "sender@example.test", subject: "First" }),
  message("m2", T2, { from: "second@example.test", subject: "Second", inReplyTo: "<m1@example.test>" }),
  message("m3", T3, { from: "third@example.test", subject: "Third" }),
];

// Recorded `gws` answers: the shapes Gmail returns for `messages.list` (two pages) and `messages.get` with format=metadata.
const headers = (from: string, subject: string, id: string, extra: Array<[string, string]> = []) => [
  { name: "From", value: from }, { name: "To", value: "Me <me@example.test>" }, { name: "Subject", value: subject },
  { name: "Message-ID", value: `<${id}@example.test>` }, { name: "Date", value: new Date(id === "m1" ? T1 : id === "m2" ? T2 : T3).toUTCString() },
  { name: "Authentication-Results", value: "mx.example.test; dmarc=pass" }, ...extra.map(([name, value]) => ({ name, value })),
];
const RECORDED: Record<string, unknown> = {
  m1: { id: "m1", threadId: "t-m1", snippet: "Snippet m1", internalDate: String(Date.parse(T1)), payload: { headers: headers("Sender <sender@example.test>", "First", "m1") } },
  m2: { id: "m2", threadId: "t-m2", snippet: "Snippet m2", internalDate: String(Date.parse(T2)), payload: { headers: headers("second@example.test", "Second", "m2", [["In-Reply-To", "<m1@example.test>"]]) } },
  m3: { id: "m3", threadId: "t-m3", snippet: "Snippet m3", internalDate: String(Date.parse(T3)), payload: { headers: headers("Third <THIRD@example.test>", "Third", "m3") } },
};

function recordedGws(): GwsCall {
  return async (_resource, method, params) => {
    if (method === "get") return RECORDED[String(params.id)];
    const after = Number(/after:(\d+)/.exec(String(params.q))?.[1] ?? 0) * 1000;
    const ids = Object.values(RECORDED).filter((m) => Number((m as { internalDate: string }).internalDate) > after).map((m) => (m as { id: string }).id).reverse(); // newest first, like Gmail
    if (!params.pageToken && ids.length > 1) return { messages: [{ id: ids[0] }], nextPageToken: "page-2", resultSizeEstimate: ids.length };
    return { messages: (params.pageToken ? ids.slice(1) : ids).map((id) => ({ id })) };
  };
}

function contractSuite(name: string, make: () => ListAdapter) {
  describe(`adapter contract: ${name}`, () => {
    test("a first list returns every message of the window, oldest first, in contract shape", async () => {
      const response = await make()({ cursor: null, sinceMs: BEFORE_ALL, limit: 100 });
      const checked = parseListResponse(JSON.stringify(response));
      expect(checked.messages.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
      expect(checked.messages.map((item) => item.from)).toEqual(["sender@example.test", "second@example.test", "third@example.test"]);
      expect(checked.messages[1]!.inReplyTo).toBe("<m1@example.test>");
      expect(checked.messages[0]!.authResults).toContain("dmarc=pass");
      expect(Date.parse(checked.messages[2]!.receivedAt)).toBe(Date.parse(T3));
    });

    test("the cursor it returns moves to the newest message", async () => {
      const response = await make()({ cursor: null, sinceMs: BEFORE_ALL, limit: 100 });
      expect(Number(response.cursor)).toBe(Date.parse(T3));
    });

    test("listing again from that cursor brings nothing new", async () => {
      const adapter = make();
      const first = await adapter({ cursor: null, sinceMs: BEFORE_ALL, limit: 100 });
      const again = await adapter({ cursor: first.cursor, sinceMs: BEFORE_ALL, limit: 100 });
      const known = new Set(first.messages.map((item) => item.id));
      expect(again.messages.every((item) => known.has(item.id))).toBe(true);
      expect(again.cursor).toBe(first.cursor);
    });

    test("an empty window answers no messages and keeps the cursor", async () => {
      const response = await make()({ cursor: null, sinceMs: AFTER_ALL, limit: 100 });
      expect(response.messages).toEqual([]);
      const kept = await make()({ cursor: String(AFTER_ALL), sinceMs: AFTER_ALL, limit: 100 });
      expect(kept.cursor).toBe(String(AFTER_ALL));
    });

    test("no field carries a body", async () => {
      const response = await make()({ cursor: null, sinceMs: BEFORE_ALL, limit: 100 });
      for (const item of response.messages) expect(Object.keys(item)).not.toContain("body");
    });
  });
}

contractSuite("scripted adapter", () => scriptedAdapter(SEED).adapter);
contractSuite("Gmail reference adapter on recorded answers", () => createGmailList(recordedGws()));

describe("Gmail reference adapter: what only it can do wrong", () => {
  test("more pages than it reads is an error, not a silent hole", async () => {
    const endless: GwsCall = async (_resource, method) => (method === "get" ? RECORDED.m1 : { messages: [{ id: "m1" }], nextPageToken: "again" });
    await expect(createGmailList(endless)({ cursor: null, sinceMs: BEFORE_ALL, limit: 100 })).rejects.toThrow("more pages");
  });

  test("a message with no internalDate is refused", async () => {
    const broken: GwsCall = async (_resource, method) => (method === "get" ? { id: "x", payload: { headers: [] } } : { messages: [{ id: "x" }] });
    await expect(createGmailList(broken)({ cursor: null, sinceMs: BEFORE_ALL, limit: 100 })).rejects.toThrow();
  });
});
