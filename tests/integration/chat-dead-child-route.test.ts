/**
 * A CHILD DEAD BETWEEN TWO TURNS: THE NEXT MESSAGE GETS ITS ANSWER.
 * @covers CCLI-03
 *
 * The real chat route and the real claude-code provider, on a real broker
 * with the fake CLI. The route registers a send's handler BEFORE `sendChat`,
 * and with the child dead in the map that handler landed on the dead one; the
 * spawn of a fresh child then cleaned the dead one up with a kill, which ended
 * the new message as a watchdog stop. The CLI still answered, into a turn the
 * route had closed: the row kept the watchdog notice, and with the resume of
 * PR #135 on top the same message went out again after every answer (PR #134
 * review, round 2). The resume half of that repro runs on the merged tree; this
 * is the half that holds on this branch alone.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { cpSync, chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { createChatRouter } from "../../server/routes/chat";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("chat-dead-child-route");
const REPO_ROOT = join(import.meta.dir, "..", "..");
let sock = "";
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v; };

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  setEnv("HOME", ROOT);
  setEnv("TOPICS_AI_BRIDGE", "1");
  sock = join(ROOT, "ai-bridge.sock");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", sock);
  // The route's envelope can carry the word "work" in its context blocks,
  // which would start the fake CLI's never-ending turn: key it on a word no
  // envelope has.
  const fake = join(ROOT, "fake-claude-sigint-exit.ts");
  cpSync(join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-sigint-exit.ts"), fake);
  writeFileSync(fake, readFileSync(fake, "utf8").replace('text.includes("work")', 'text.includes("START_LONG_TURN")'));
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const pid = sock.replace(/\.sock$/, ".pid");
    if (existsSync(pid)) process.kill(Number(readFileSync(pid, "utf8").trim()), "SIGTERM");
  } catch { /* already gone */ }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = slackMs(10_000)): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(25);
  return ok();
}

describe("a child dead between turns, through the real route", () => {
  test("the next message gets its answer, not a watchdog notice", async () => {
    const sessionKey = "topic:dead-child-route";
    const ctx: AppContext = await createTestAppContext();
    const frames: Array<Record<string, unknown>> = [];
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
      .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };
    ctx.saveSingleTopic({
      id: "t-dead-child-route", name: "dead", slug: "dead", parentId: null, links: [], sessionKey,
      color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), archived: false, provider: "claude-code",
    } as unknown as Topic);

    const { ClaudeCodeProvider } = await import("../../server/providers/claude-code");
    const { getAiBridgeClient } = await import("../../server/lib/ai-bridge-client");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: ROOT });
    provider.start();
    const p = provider as unknown as { processes: Map<string, { alive: boolean }> };
    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
      resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [],
      autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: ROOT,
    } as never);
    const post = async (text: string) => {
      const url = new URL("http://topics.test/api/chat");
      const resp = await chatRouter(new Request(url.toString(), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }] }),
      }), url, "/api/chat", "POST");
      expect(resp?.status).toBe(200);
      resp?.body?.cancel().catch(() => {});
    };
    const ends = () => frames.filter((f) => f.type === "stream:end");
    const lastAssistant = () => ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant").at(-1);

    try {
      await post("ciao");
      expect(await until(() => ends().length === 1)).toBe(true);
      const pp = p.processes.get(sessionKey)!;
      // The child exits on its own between turns; the dead pp stays in the map.
      getAiBridgeClient().signal(sessionKey, "SIGINT");
      expect(await until(() => !pp.alive)).toBe(true);

      await post("tutto ok?");
      expect(await until(() => ends().length === 2)).toBe(true);
      const end = ends()[1];
      const row = lastAssistant();

      expect(end.stopCause).toBeUndefined();
      expect(row?.content ?? "").toContain("ricevuto:");
      expect((row?.blocks ?? []).filter((b) => (b as { kind?: string }).kind === "error")).toEqual([]);
    } finally {
      provider.stop();
    }
  }, 45_000);
});
