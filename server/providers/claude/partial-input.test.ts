/**
 * @covers CCLI-10
 *
 * The tool input reaches the handler once, whichever of its two sources lands
 * first: the partial stream's `content_block_stop` or the cumulative snapshot.
 */
import { describe, test, expect } from "bun:test";
import { finalizeToolArgs } from "./partial-input";
import type { PersistentProcess } from "./persistent-process";
import type { StreamHandler } from "../types";

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
