/**
 * @covers CCLI-10
 *
 * The tool input reaches the handler once, whichever of its two sources lands
 * first: the partial stream's `content_block_stop` or the cumulative snapshot.
 */
import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectUserInputForTool, finalizeToolArgs } from "./partial-input";
import type { PersistentProcess } from "./persistent-process";
import type { StreamHandler } from "../types";
import { closeDatabase, getDatabase, initDatabase } from "../../db";
import { insertSubagent } from "../../lib/subagent-store";

function processRecord(): PersistentProcess {
  return {
    pendingInputs: new Map(),
    sidechain: { updateParentInput: () => {} },
  } as unknown as PersistentProcess;
}

describe("finalizeToolArgs", () => {
  test("delivers a tool's complete input once, however many times it is called", () => {
    const pp = processRecord();
    const updates: Array<Record<string, unknown>> = [];
    const handler = { onToolArgsUpdate: (_id: string, args: Record<string, unknown>) => updates.push(args) } as unknown as StreamHandler;
    finalizeToolArgs(pp, handler, "tool-1", "Bash", { command: "ls" }, () => "s1");
    finalizeToolArgs(pp, handler, "tool-1", "Bash", { command: "ls" }, () => "s1");
    expect(updates).toEqual([{ command: "ls" }]);
  });

  test("a call already settled gets no late input", () => {
    const pp = processRecord();
    pp.settledToolCalls = new Set(["tool-2"]);
    const updates: unknown[] = [];
    const handler = { onToolArgsUpdate: (...a: unknown[]) => updates.push(a) } as unknown as StreamHandler;
    finalizeToolArgs(pp, handler, "tool-2", "Bash", { command: "ls" }, () => "s1");
    expect(updates).toEqual([]);
  });
});

describe("detectUserInputForTool — a spawn_agent child's panel never surfaces", () => {
  let tempRoot = "";

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "partial-input-askuser-"));
    initDatabase(resolve(import.meta.dir, "../../.."), tempRoot);
  });

  afterAll(() => {
    try { closeDatabase(); } catch { /* setup may have failed before opening it */ }
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can hold the temp dir open a moment longer; the OS temp cleaner reclaims it.
    }
  });

  test("a CLI child's ask_user_question never reaches onUserInputRequired, nor pendingInputs", () => {
    insertSubagent(getDatabase(), {
      id: "cli-child-ask-1", parentSessionKey: "topic:parent", name: "scout", model: "sonnet", agentType: "scout",
      effort: "low", promptSnippet: "look", cwd: tempRoot, branch: null, claudeSessionId: "cli-child-ask-1",
      createdAt: new Date().toISOString(),
    });
    const pp = processRecord();
    let fired = false;
    const handler = { onUserInputRequired: () => { fired = true; } } as unknown as StreamHandler;
    detectUserInputForTool(pp, handler, "tool-ask-1", "mcp__topics__ask_user_question", { questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }] }] }, () => "cli-child-ask-1");
    expect(fired).toBe(false);
    expect(pp.pendingInputs.has("tool-ask-1")).toBe(false);
  });

  test("a person's chat still gets the panel", () => {
    const pp = processRecord();
    let fired = false;
    const handler = { onUserInputRequired: () => { fired = true; } } as unknown as StreamHandler;
    detectUserInputForTool(pp, handler, "tool-ask-2", "mcp__topics__ask_user_question", { questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }] }] }, () => "topic:a-real-chat");
    expect(fired).toBe(true);
    expect(pp.pendingInputs.has("tool-ask-2")).toBe(true);
  });
});
