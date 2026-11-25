/**
 * A sub-agent that stops its parent's service and relaunches it without a wake
 * is replacing it: the relaunch is owned by the parent, so archiving the child
 * at the end of its turn does not stop the service.
 *
 * @covers PROCESS-13
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const STATE = mkdtempSync(join(tmpdir(), "topics-adopt-state-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { adoptedByParent, startCommandProcess } = await import("./processes-commands");
const { runningScripts } = await import("./processes-state");
const { stopTopicCommandProcesses } = await import("./command-process-lifecycle");
const { hasCommandShell } = await import("../lib/command-process");
const { commandProcessGroup, processGroupAlive } = await import("../lib/command-process-groups");
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), "topics-adopt-project-")));
afterAll(() => {
  runningScripts.clear();
  rmSync(PROJECT, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(STATE, { recursive: true, force: true });
});

const dbWithChild = (parentKey: string | null) => ({
  query: () => ({ get: () => (parentKey ? { id: "c1", parent_session_key: parentKey, name: "child", state: "running" } : null) }),
}) as never;

function stoppedParentServer(label: string) {
  runningScripts.set("p1", {
    processId: "p1", scriptName: label, command: label, projectPath: "/x", status: "error",
    startedAt: "x", output: [], outputBytes: 0, proc: null, source: "command",
    cmd: { sessionKey: "topic:parent", topicId: "parent-topic", wake: false, stopped: true },
  } as never);
}

const request = (db: never) => ({ command: "make serve", sessionKey: "topic:child", topicId: "child-topic", wake: false, db });

describe("adoptedByParent", () => {
  test("a wake:false relaunch of a stopped parent command goes to the parent", () => {
    stoppedParentServer("make serve");
    const out = adoptedByParent(request(dbWithChild("topic:parent")));
    expect(out.sessionKey).toBe("topic:parent");
    expect(out.topicId).toBe("parent-topic");
    runningScripts.clear();
  });

  test("a different command stays with the child", () => {
    stoppedParentServer("make other");
    const out = adoptedByParent(request(dbWithChild("topic:parent")));
    expect(out.topicId).toBe("child-topic");
    runningScripts.clear();
  });

  test("a chat that is not a sub-agent is left alone", () => {
    stoppedParentServer("make serve");
    expect(adoptedByParent(request(dbWithChild(null))).topicId).toBe("child-topic");
    runningScripts.clear();
  });
});

// The real path: the child launches through `startCommandProcess`, then its
// archive stops the commands of its topic (`stopTopicCommandProcesses`, what
// archiving a topic calls), and the relaunched service has to survive it.
describe.skipIf(!hasCommandShell())("archiving the child after the relaunch", () => {
  // A db that knows the subagent row and nothing else (no card, no quota).
  const realDb = (parentKey: string | null) => ({
    query: (sql: string) => ({ get: () => (sql.includes("subagents") && parentKey ? { id: "c1", parent_session_key: parentKey, name: "child", state: "running" } : null) }),
    prepare: () => ({ get: () => null }),
  }) as never;

  async function launchThenArchive(parentKey: string | null) {
    const started = startCommandProcess({
      projectPath: PROJECT, cwd: PROJECT, command: "sleep 60", sessionKey: "topic:child", topicId: "child-topic", wake: false, db: realDb(parentKey),
    });
    expect(started).not.toBeNull();
    const group = commandProcessGroup(started!.processId)!;
    stopTopicCommandProcesses("child-topic");
    return { processId: started!.processId, pgid: group.pgid };
  }

  async function aliveAfter(pgid: number, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!processGroupAlive(pgid)) return false;
      await Bun.sleep(100);
    }
    return processGroupAlive(pgid);
  }

  function kill(pgid: number) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* test cleanup: the group may already be gone */ }
  }

  test("the parent's relaunched service is still alive after the child's archive", async () => {
    stoppedParentServer("sleep 60");
    const { processId, pgid } = await launchThenArchive("topic:parent");
    try {
      expect(await aliveAfter(pgid, 3000)).toBe(true);
      expect(runningScripts.get(processId)?.cmd).toMatchObject({ sessionKey: "topic:parent", topicId: "parent-topic" });
      expect(runningScripts.get(processId)?.status).toBe("running");
    } finally { kill(pgid); runningScripts.clear(); }
  }, 15_000);

  test("without a stopped parent command the child's archive stops it", async () => {
    const { pgid } = await launchThenArchive("topic:parent");
    try {
      expect(await aliveAfter(pgid, 8000)).toBe(false);
    } finally { kill(pgid); runningScripts.clear(); }
  }, 15_000);
});
