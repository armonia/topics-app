/**
 * A STOP THE MACHINE WANTED IS STILL SILENT AFTER THE NEXT BOOT (fourth review
 * of PR #135).
 *
 * The third round closed the turn in the route before calling the provider,
 * so claude-code's synchronous `onAborted` never reached the finalize. The
 * tools in flight were then closed by `endStream` with the interrupted prefix, and
 * the next boot's repair pass (`bonificaTurniMuti`) read that as a mute
 * interrupted turn and added the resumable «Riprende da solo»: the sweep
 * resent the message, which on main never happened.
 *
 * The rule (Attilio's): a machine stop takes main's path, `onAborted` through
 * the finalize with its true cause; the finalize writes no resumable notice
 * for it and closes its tools with a text the repair pass does not take for a
 * mute turn; and the repair pass skips a turn the machine stopped on purpose.
 *
 * Ported from the reviewers' matrix: real chat and topics routes, the boot's
 * repair pass, the real sweep, and a provider that answers an abort the way
 * claude-code does (a synchronous `onAborted`, then the handler released).
 *
 * @covers RESUME-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { createTopicsRouter } from "../../server/routes/topics";
import { riprendiTurniInterrotti } from "../../server/lib/ripresa-boot";
import { bonificaTurniMuti } from "../../server/lib/verdetto-turno-interrotto";
import { INTERRUPTED_MARKER } from "../../server/lib/stale-stream-sweep";
import { internalAbortRequest, type MachineStopCause } from "../../server/lib/abort-cause";
import { resetTurnEndRegistry } from "../../server/providers/turn-end-registry";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("machine-stop-reboot-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

let captured: StreamHandler | undefined;
// "claude-code" answers the abort at once; "native" answers nothing, and its
// tool, cancelled by the abort, reports late with the sentence the repair pass
// looks for (`MOTIVO_ANNULLATO` in providers/native/tools.ts).
let answers: "claude-code" | "native" = "claude-code";
const registered = registerProvider({ type: "openai", apiKey: "" } as never) as unknown as Record<string, unknown>;
Object.defineProperty(registered, "connected", { configurable: true, get: () => true });
registered.unregisterStreamHandler = () => { captured = undefined; };
registered.abort = async (_sk: string, _runId: string | undefined, reason: string) => {
  const h = captured;
  captured = undefined;
  if (answers === "native") setTimeout(() => h?.onToolResult("toolu_x", "[comando interrotto: il turno è stato annullato mentre girava]", true), 20);
  else h?.onAborted?.({ turnEnd: { end: "cancelled", cause: reason } } as never);
};
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

type State = "tool" | "question" | "permission";

async function stoppedThenRestarted(sessionKey: string, state: State, cause: MachineStopCause | null, reporter: typeof answers = "claude-code") {
  captured = undefined;
  answers = reporter;
  resetTurnEndRegistry();
  const ctx: AppContext = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  ctx.saveSingleTopic({
    id: `t-${sessionKey}`, name: "reboot", slug: "reboot", parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archived: false, provider: "openai",
  } as Topic);
  const provider = {
    name: "fake", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => { captured = undefined; },
    sendChat: () => new Promise(() => {}),
    defaultModel: () => "fake-model", abort: async () => {}, start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  const chat = createChatRouter(ctx, {
    resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
    resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [],
    autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: testTmpDir("machine-stop-reboot-ws"),
  } as never);
  const topics = createTopicsRouter(ctx);

  const url = new URL("http://localhost/api/chat");
  const resp = await chat(new Request(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "Envelope: fai il lavoro" }] }),
  }), url, "/api/chat", "POST");
  expect(resp?.status).toBe(200);
  resp?.body?.cancel().catch(() => {});
  const h = captured!;
  h.onToolStart("toolu_x", state === "question" ? "mcp__topics__ask_user_question" : "Bash", { command: "bun test" } as never);
  if (state === "question") {
    h.onUserInputRequired?.("toolu_x", "mcp__topics__ask_user_question", { kind: "questions", questions: [{ question: "A o B?", options: [{ label: "A" }, { label: "B" }] }] } as never);
  }
  if (state === "permission") {
    const rowId = ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant").at(-1)!.id;
    ctx.updateToolCallFields(sessionKey, "toolu_x", { status: "awaiting_permission" }, { rowId });
  }

  const stop = cause === null
    ? new Request("http://topics.test/api/chat/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey }) })
    : internalAbortRequest(sessionKey, cause);
  const stopped = await topics(stop, new URL(stop.url), "/api/chat/abort", "POST") as Response;
  expect(stopped.status).toBe(200);
  await new Promise((r) => setTimeout(r, 60));

  // The next boot: the registry is empty, the repair pass runs, then the sweep.
  ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ? AND role = 'user'", [new Date(Date.now() - 10 * 60_000).toISOString(), sessionKey]);
  resetTurnEndRegistry();
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  const resent: string[] = [];
  try {
    bonificaTurniMuti(ctx.db as never, INTERRUPTED_MARKER.replace(/^⚠️\s*/, ""));
    await riprendiTurniInterrotti(
      {
        db: ctx.db, getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k),
        isStreaming: () => false, providerBusy: () => false, bootedAtMs: Date.now(),
      },
      async (req) => {
        const body = await req.clone().json().catch(() => null) as { sessionKey?: string; messages?: Array<{ content?: string }> } | null;
        if (body?.sessionKey === sessionKey) resent.push(body.messages?.[0]?.content ?? "");
        return new Response(null, { status: 200 });
      },
      { responseMs: 300, streamMs: 300 },
    );
  } finally { console.log = log; console.warn = warn; }
  const turn = ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant").at(-1);
  const titles = (ctx.db.query("SELECT title FROM activity_log WHERE session_key = ?").all(sessionKey) as Array<{ title: string }>).map((r) => r.title);
  return {
    notices: (turn?.blocks ?? []).filter((b) => b.kind === "error"),
    tool: (turn?.blocks ?? []).flatMap((b) => (b.kind === "tool" ? [b.toolCall] : [])).at(0),
    latencyMs: turn?.latencyMs,
    titles,
    resent,
  };
}

describe("a stop the machine wanted is still silent after the next boot", () => {
  for (const cause of ["stall", "superseded", "wall-clock"] as const) {
    for (const state of ["tool", "question", "permission"] as const) {
      test(`${cause} with a ${state} open: no notice after the boot's repair, nothing resent`, async () => {
        const r = await stoppedThenRestarted(`topic:reboot-${cause}-${state}`, state, cause);
        expect(r.notices).toEqual([]);
        expect(r.resent).toEqual([]);
        // Main's path: the finalize closed the tool and timed the turn...
        expect(r.tool?.status).toBe("error");
        expect(r.tool?.error ?? "").not.toMatch(/^Interrotto/);
        expect(typeof r.latencyMs).toBe("number");
        // ...and the log names the machine's cause, never the person.
        expect(r.titles).not.toContain("stream aborted by user");
        expect(r.titles).not.toContain("stop pressed by user");
      });
    }
  }

  // The provider's own report can come after the route closed the turn, and
  // overwrite the tool's sentence: the stop is known from the log instead.
  for (const cause of ["stall", "superseded", "wall-clock"] as const) {
    test(`${cause} on a provider whose tool reports late: nothing resent after the boot`, async () => {
      const r = await stoppedThenRestarted(`topic:reboot-native-${cause}`, "tool", cause, "native");
      expect(r.notices).toEqual([]);
      expect(r.resent).toEqual([]);
    });
  }

  for (const state of ["tool", "question", "permission"] as const) {
    test(`the person's Stop with a ${state} open: as on main, no notice and nothing resent`, async () => {
      const r = await stoppedThenRestarted(`topic:reboot-person-${state}`, state, null);
      expect(r.notices).toEqual([]);
      expect(r.resent).toEqual([]);
      expect(r.tool?.error).toBe("Aborted by user");
    });
  }
});
