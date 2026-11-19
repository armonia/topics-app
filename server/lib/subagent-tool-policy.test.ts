/** @covers SUBAGENT-23 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnedChildOf, toolAllowedByPolicy } from "./subagent-tool-policy";
import { insertSubagent } from "./subagent-store";

describe("native sub-agent tool policy", () => {
  test("a child never sees ask_user_question, even when its profile grants it", () => {
    const granted = { allowed: new Set(["ask_user_question", "bash"]), noDelegation: false };
    expect(toolAllowedByPolicy(granted, "ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy(granted, "mcp__topics__ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy({ allowed: null, noDelegation: false }, "ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy(granted, "bash")).toBe(true);
  });

  test("a chat that is not a child keeps the question tool", () => {
    expect(toolAllowedByPolicy(null, "ask_user_question")).toBe(true);
  });
});

const SQL = ["20261001203100-subagents.sql", "20261004180000-subagents-native-runtime.sql", "20261115201418-subagent-remote-node.sql"]
  .map((f) => readFileSync(resolve(import.meta.dir, "../db/migrations", f), "utf8")).join("\n");

function db(): Database {
  const d = new Database(":memory:");
  d.exec(SQL);
  return d;
}

describe("spawnedChildOf — the one choke point a CLI child shares with a native one", () => {
  test("a CLI (claude-code) child is found by its OWN id, not by a session_key column it never gets", () => {
    const d = db();
    insertSubagent(d, {
      id: "cli-child-1", parentSessionKey: "topic:parent", name: "scout", model: "sonnet", agentType: "scout",
      effort: "low", promptSnippet: "look", cwd: "/p", branch: null, claudeSessionId: "sid-1", createdAt: "2026-11-19T10:00:00.000Z",
    });
    expect(spawnedChildOf(d, "cli-child-1")?.id).toBe("cli-child-1");
  });

  test("a native child is found by its chat's session_key", () => {
    const d = db();
    insertSubagent(d, {
      id: "native-child-1", parentSessionKey: "topic:parent", name: "scout", model: "sonnet", agentType: "scout",
      effort: "low", promptSnippet: "look", cwd: "/p", branch: null, claudeSessionId: null, createdAt: "2026-11-19T10:00:00.000Z",
      runtime: "topics", sessionKey: "topic:native-child-chat",
    });
    expect(spawnedChildOf(d, "topic:native-child-chat")?.id).toBe("native-child-1");
  });

  test("a person's chat or a dispatched board session is not a child", () => {
    const d = db();
    expect(spawnedChildOf(d, "topic:some-chat")).toBeNull();
  });
});
