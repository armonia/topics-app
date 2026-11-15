/**
 * @covers CHAT-PERSIST-02
 * A native child waiting on its own work is looked at again every
 * `waitPollMs` (`watchWaitingChild`). When the database refuses the close as
 * busy, the throw must not leave the interval: that is the net that takes the
 * server down. Reached through the boot adoption, the one exported door that
 * starts the watch for a `running` child with work still owed.
 *
 * What is injected: `getTopicBySessionKey`, the one dependency the close
 * calls after the child row is written. The store helpers (`getSubagent`,
 * `setSubagentState`) swallow their own errors, so a busy refusal can only
 * come out of the close through the lent dependencies.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { adoptNativeChildrenAtBoot, configureNativeSubagents, _resetNativeSubagents, type NativeSubagentDeps } from "./native-subagents";
import { getSubagent, insertSubagent } from "./subagent-store";

const busy = () => Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY", errno: 5 });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let tempRoot = "";
let uncaught: unknown[] = [];
const onUncaught = (err: unknown) => { uncaught.push(err); };

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "native-subagents-busy-"));
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);
  process.on("uncaughtException", onUncaught);
});

afterAll(() => {
  process.off("uncaughtException", onUncaught);
  try { closeDatabase(); } catch { /* the setup may have failed before opening it */ }
  rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  configureNativeSubagents(null);
  _resetNativeSubagents();
  uncaught = [];
});

/** A running native child whose last reported turn completed, with work still owed. */
async function waitingChild(id: string, getTopicBySessionKey: NativeSubagentDeps["getTopicBySessionKey"]) {
  const db = getDatabase();
  const sessionKey = `topic:${id}`;
  insertSubagent(db, {
    id, parentSessionKey: "topic:parent", name: "waiting child", model: null, agentType: null, effort: null,
    promptSnippet: "p", cwd: tempRoot, branch: null, claudeSessionId: null,
    runtime: "topics", sessionKey, createdAt: new Date().toISOString(),
  });
  db.run("INSERT INTO subagent_reported_turns (subagent_id, turn_id, status, reported_at) VALUES (?, 't1', 'completed', ?)", [id, new Date().toISOString()]);
  const state = { owed: true, log: [] as string[] };
  configureNativeSubagents({
    route: async () => new Response(null, { status: 200 }),
    isBusy: () => false,
    getTopicBySessionKey,
    saveTopic: () => {},
    loadMessages: () => [],
    engineReady: () => true,
    backgroundWork: () => state.owed,
    waitPollMs: 10,
    log: (m) => { state.log.push(m); },
  });
  await adoptNativeChildrenAtBoot({ waitMs: 0 });
  return state;
}

describe("watchWaitingChild under a busy database", () => {
  test("a busy refusal of the close does not leave the interval, and the child ends up retired", async () => {
    const id = "busy-child-1";
    let calls = 0;
    const state = await waitingChild(id, () => {
      calls += 1;
      if (calls === 1) throw busy();
      return null;
    });
    expect(getSubagent(getDatabase(), id)?.state).toBe("running");

    state.owed = false;
    await sleep(120);

    expect(uncaught).toEqual([]);
    expect(state.log.some((m) => m.includes("database busy"))).toBe(true);
    expect(getSubagent(getDatabase(), id)?.state).toBe("retired");
  });
});
