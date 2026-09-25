/**
 * A STOP THE MACHINE WANTED, WITH THE REAL claude-code PROVIDER (fourth review
 * of PR #135).
 *
 * The real ClaudeCodeProvider drives a fake CLI that dies on SIGINT like the
 * real one, through the real chat and topics routes; then the next boot's
 * repair pass and the sweep. A turn with a tool in flight, stopped by the
 * person (a plain request) or by the machine (an internal request with its
 * cause), keeps no notice and resends nothing, as on main.
 *
 * Ported from the reviewers' repro (scratchpad r3parity/zz-r3p-realboot).
 *
 * @covers RESUME-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "r3p-realboot-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  const fake = join(tempDir, "fake-claude-sigint-exit.ts");
  cpSync(join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-sigint-exit.ts"), fake);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
});
afterAll(async () => {
  try { const { getProvider } = await import("../../server/providers"); await (getProvider("claude-code") as any)?.stop?.(); } catch {}
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("a stop with a tool in flight, real claude-code provider", () => {
  test("the person and every machine cause: no notice after the boot, nothing resent", async () => {
    const { setupTestDataDir, createTestAppContext, testTmpDir } = await import("./helpers");
    setupTestDataDir(testTmpDir("r3p-realboot-data"));
    const { createChatRouter } = await import("../../server/routes/chat");
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { riprendiTurniInterrotti } = await import("../../server/lib/ripresa-boot");
    const registry = await import("../../server/providers/turn-end-registry");
    const { registerProvider } = await import("../../server/providers");
    const { internalAbortRequest } = await import("../../server/lib/abort-cause");
    const provider = registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as any;
    const ctx = await createTestAppContext();
    const frames: any[] = [];
    (ctx as any).broadcastToAll = (m: any) => frames.push(m);
    (ctx as any).broadcastToTopicSubscribers = (_i: string, m: any) => frames.push(m);
    const chat = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
      getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {},
      updateUnreadCount: () => {}, browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: tempDir,
    } as never);
    const topics = createTopicsRouter(ctx);
    const causes = [null, "superseded", "stall", "wall-clock"] as const;
    for (const cause of causes) {
      const tag = cause ?? "plain";
      const sk = `topic:rc${tag.slice(0, 4)}`;
      frames.length = 0; registry.resetTurnEndRegistry();
      ctx.saveSingleTopic({ id: `t-${tag}-0000000000`, name: tag, slug: tag, parentId: null, links: [], sessionKey: sk, color: "#5865f2",
        icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "claude-code" } as any);
      const url = new URL("http://localhost/api/chat");
      const resp = await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: sk, messages: [{ role: "user", content: "do some work" }] }) }), url, "/api/chat", "POST");
      expect(resp?.status).toBe(200);
      const reader = resp!.body!.getReader();
      (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
      for (let i = 0; i < 100 && !frames.some((f) => f.type === "stream:tool_start" || f.type === "stream:tool_call"); i++) await Bun.sleep(100);
      expect(frames.some((f) => /tool/.test(f.type))).toBe(true);
      frames.length = 0;
      const req = cause === null
        ? new Request("http://localhost/api/chat/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk }) })
        : internalAbortRequest(sk, cause);
      const ar = await topics(req, new URL(req.url), "/api/chat/abort", "POST") as Response;
      expect(ar.status).toBe(200);
      await Bun.sleep(1500); // child exit + post-SIGINT lines
      const log = ctx.db.query("SELECT title FROM activity_log WHERE session_key = ? ORDER BY id").all(sk).map((r: any) => r.title);
      ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ? AND role = 'user'", [new Date(Date.now() - 10 * 60_000).toISOString(), sk]);
      // --- next boot: server.ts finalizeOrphanedRunningTools third pass, then the resume sweep
      registry.resetTurnEndRegistry();
      const { bonificaTurniMuti } = await import("../../server/lib/verdetto-turno-interrotto");
      const { INTERRUPTED_MARKER } = await import("../../server/lib/stale-stream-sweep");
      const repaired = bonificaTurniMuti(ctx.db as any, INTERRUPTED_MARKER.replace(/^⚠️\s*/, ""));
      const afterBoot = ctx.loadLocalMessages(sk).filter((m: any) => m.role === "assistant").flatMap((m: any) => (m.blocks ?? []).filter((b: any) => b.kind === "error").map((b: any) => b.text.slice(0, 70)));
      const resent: string[] = [];
      const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {};
      try {
        await riprendiTurniInterrotti({ db: ctx.db, getTopicBySessionKey: (k: string) => ctx.getTopicBySessionKey(k), isStreaming: () => false,
          providerBusy: () => false, bootedAtMs: Date.now() } as never, async (r: Request) => {
          const b = await r.clone().json().catch(() => null) as any; if (b?.sessionKey === sk) resent.push(b.messages?.[0]?.content); return new Response(null, { status: 200 }); },
          { responseMs: 300, streamMs: 300 });
      } finally { console.log = l; console.warn = w; }
      expect(repaired).toBe(0);
      expect(afterBoot).toEqual([]);
      expect(resent).toEqual([]);
      // A machine's stop is never logged as the person's.
      if (cause !== null) expect(log.filter((t: string) => / by user$/.test(t))).toEqual([]);
    }
  }, 60_000);
});
