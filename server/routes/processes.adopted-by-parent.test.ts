/**
 * A sub-agent that stops its parent's service and relaunches it without a wake
 * is replacing it: the relaunch is owned by the parent, so archiving the child
 * at the end of its turn does not stop the service.
 *
 * @covers PROCESS-13
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const STATE = mkdtempSync(join(tmpdir(), "topics-adopt-state-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { adoptedByParent } = await import("./processes-commands");
const { runningScripts } = await import("./processes-state");
afterAll(() => {
  runningScripts.clear();
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
