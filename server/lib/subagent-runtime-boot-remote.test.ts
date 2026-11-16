/**
 * A restart of this server does not end a child that runs on a node: the node keeps
 * working and the remote watch settles it. Before, the boot sweep reported every
 * `running` row without a terminal here as lost, remote ones included (16/11: a land's
 * restart lost 3 of 6 children mid-run on the PC).
 *
 * @covers SUBAGENT-28
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { getSubagent, insertSubagent, markSubagentRemote } from "./subagent-store";
import { _forgetSubAgentMemory, bootChildSweep, configureSubagentRuntime } from "./subagent-runtime";

let root = "";
afterEach(() => {
  try { closeDatabase(); } catch { /* best effort */ }
  _forgetSubAgentMemory();
  // Windows may still hold the database file a moment after close: a leftover temp dir is harmless.
  if (root) try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("the boot sweep keeps a remote child running and still reports a local CLI child lost", () => {
  root = mkdtempSync(join(tmpdir(), "subagent-boot-remote-"));
  initDatabase(resolve(import.meta.dir, "../.."), root);
  const base = {
    parentSessionKey: "topic:boot-parent", model: null, agentType: null, effort: null,
    promptSnippet: "do it", cwd: root, branch: null, claudeSessionId: null, createdAt: new Date().toISOString(),
  };
  insertSubagent(getDatabase(), { ...base, id: "remote-child", name: "on the node" });
  markSubagentRemote(getDatabase(), "remote-child", { machineId: "node-1", runId: "run-1" });
  insertSubagent(getDatabase(), { ...base, id: "local-child", name: "here" });

  const ended: string[] = [];
  configureSubagentRuntime({
    liveChildren: () => [],
    adoptTranscriptId: () => {},
    readLines: async () => null,
    branchOf: () => null,
    park: () => false,
    broadcast: () => {},
    handler: () => (info) => { ended.push((info as { agentId?: string; id?: string }).agentId ?? (info as { id?: string }).id ?? "?"); },
  });
  bootChildSweep();

  expect(getSubagent(getDatabase(), "remote-child")?.state).toBe("running");
  expect(getSubagent(getDatabase(), "local-child")?.state).not.toBe("running");
});
