/**
 * The MCP ask_user_question of a Codex spawn_agent child: the panel must
 * never surface in the topic the person is looking at.
 * @covers SUBAGENT-23
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { insertSubagent } from "../lib/subagent-store";
import { CodexProvider } from "./codex";
import { makeHandler, pushEvent } from "./codex-test-helpers";

describe("an MCP ask_user_question — a spawn_agent child's panel never surfaces", () => {
  let tempRoot = "";

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "codex-ask-user-"));
    initDatabase(resolve(import.meta.dir, "../.."), tempRoot);
  });

  afterAll(() => {
    try { closeDatabase(); } catch { /* setup may have failed before opening it */ }
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may hold the temp dir briefly */ }
  });

  test("a CLI child's ask_user_question never reaches onUserInputRequired", () => {
    insertSubagent(getDatabase(), {
      id: "codex-child-ask-1", parentSessionKey: "topic:parent", name: "scout", model: "sonnet", agentType: "scout",
      effort: "low", promptSnippet: "look", cwd: tempRoot, branch: null, claudeSessionId: "codex-child-ask-1",
      createdAt: new Date().toISOString(),
    });
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    let fired = false;
    h.onUserInputRequired = () => { fired = true; };
    pushEvent(provider, "codex-child-ask-1", {
      type: "item.started",
      item: { type: "mcp_tool_call", id: "ask-1", server: "topics", tool: "ask_user_question", arguments: { questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }] }] } },
    }, h);
    expect(fired).toBe(false);
  });

  test("a person's chat still gets the panel", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    let fired = false;
    h.onUserInputRequired = () => { fired = true; };
    pushEvent(provider, "topic:a-real-chat", {
      type: "item.started",
      item: { type: "mcp_tool_call", id: "ask-2", server: "topics", tool: "ask_user_question", arguments: { questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }] }] } },
    }, h);
    expect(fired).toBe(true);
  });
});
