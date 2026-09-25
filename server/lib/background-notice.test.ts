/**
 * THE BACKGROUND NOTICE IS A SERVICE ROW. The second review of 25/09 found it
 * written as an assistant row with its sentence in `content`: the sentence
 * entered every model history, and the row became the chat's last word, which
 * is all the resume sweep reads, so a cut turn under it was never resumed.
 * @covers MONITOR-02
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { postBackgroundNotice } from "./background-notice";
import { riprendiTurniInterrotti } from "./ripresa-boot";
import { INTERRUPTED_MARKER } from "./stale-stream-sweep";
import { resetTurnEndRegistry } from "../providers/turn-end-registry";
import { loadActiveBranchForReplay } from "../providers/claude-code";
import { nativeHistorySource } from "../providers/native/history-source";
import { buildProviderHistory } from "../utils/build-provider-history";

const ROOT = testTmpDir("background-notice");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));
beforeEach(() => resetTurnEndRegistry());

describe("the background notice", () => {
  test("its sentence reaches no model history: not the claude-code recap, not the native rehydrate, not the API providers", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:bg-notice-history";
    ctx.appendLocalMessage(sk, "user", "lancia un agente in background");
    ctx.appendLocalMessage(sk, "assistant", "Agente lanciato.");
    postBackgroundNotice(ctx, { sessionKey: sk, topicId: "t" }, { kind: "background-notice", event: "closed", tasks: ["Explore agent"], why: "silent" });
    ctx.appendLocalMessage(sk, "user", "e adesso?");
    const said = (xs: Array<{ content: string }>) => xs.some((m) => m.content.includes("Background work"));
    expect(said(loadActiveBranchForReplay(sk))).toBe(false);
    expect(said(nativeHistorySource(ctx as never, sk))).toBe(false);
    expect(said(buildProviderHistory(ctx.loadActiveThread(sk)))).toBe(false);
    // The row is still there, as a block the client draws.
    const row = ctx.db.query(`SELECT content, blocks FROM messages WHERE session_key = ? AND blocks LIKE '%background-notice%'`).get(sk) as { content: string; blocks: string };
    expect(row.content).toBe("");
    expect(JSON.parse(row.blocks)[0]).toMatchObject({ kind: "background-notice", text: expect.stringContaining("Explore agent") });
  });

  for (const notices of [1, 6]) test(`a watchdog cut that promised «Riprende da solo» is resent even with ${notices} notice(s) after it`, async () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER)`);
    const t0 = new Date(Date.now() - 4 * 60_000).toISOString();
    db.run("INSERT INTO messages VALUES ('u0','topic:x','user','misura la ripresa',NULL,0,?,0,NULL,0)", [t0]);
    const cut = JSON.stringify([{ kind: "error", text: INTERRUPTED_MARKER, cause: "watchdog", at: t0 }]);
    db.run("INSERT INTO messages VALUES ('a0','topic:x','assistant',?,?,0,?,1,'u0',0)", [INTERRUPTED_MARKER, cut, new Date(Date.now() - 3 * 60_000).toISOString()]);
    const noticeCtx = {
      activeStreams: new Map(), broadcastToAll: () => {},
      appendLocalMessage: (sk: string, role: string, content: string, _a: unknown, blocks?: unknown[]) => {
        const last = db.query("SELECT id, sort_order FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1").get(sk) as { id: string; sort_order: number };
        const id = crypto.randomUUID();
        db.run("INSERT INTO messages VALUES (?,?,?,?,?,0,?,?,?,0)", [id, sk, role, content, JSON.stringify(blocks ?? null), new Date().toISOString(), last.sort_order + 1, last.id]);
        return { id };
      },
    };
    // Six: config changes made while the work runs write one each, and the sweep once looked back five rows only.
    postBackgroundNotice(noticeCtx as never, { sessionKey: "topic:x", topicId: "t" }, { kind: "background-notice", event: "closed", tasks: ["sleep 600"], why: "stuck-turn" });
    for (let i = 1; i < notices; i++) postBackgroundNotice(noticeCtx as never, { sessionKey: "topic:x", topicId: "t" }, { kind: "background-notice", event: "deferred", change: "model" });
    const resent: unknown[] = [];
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
      await riprendiTurniInterrotti({ db, getTopicBySessionKey: () => ({ archived: false }) } as never, async (req) => {
        resent.push(await req.json());
        return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
      });
    } finally { console.log = log; console.warn = warn; }
    expect(resent.length).toBe(1);
  });
});
