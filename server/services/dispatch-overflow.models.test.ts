/**
 * A node that declares its models: the overflow skips it for a card whose model
 * it lacks, and reads its refusal as a verdict on that machine.
 *
 * @covers KANBAN-76
 */
import { describe, expect, it } from "bun:test";
import { isModelUnavailable, machineLacksModel, pickOverflowMachine, type OverflowMachine } from "./dispatch-overflow";

const node = (over: Partial<OverflowMachine>): OverflowMachine => ({ id: "n1", name: "n1", kind: "node", online: true, ...over });
const opts = (model: string | null) => ({ cloudCredit: false, githubOrigin: false, model, load: () => 0 });

describe("a node that lacks the card's model", () => {
  it("is not chosen, and the next node is", () => {
    const old = node({ id: "old", models: ["claude-opus-5", "claude-sonnet-5"] });
    const fresh = node({ id: "fresh", models: ["claude-sonnet-5-5"] });
    expect(pickOverflowMachine([old, fresh], opts("claude-sonnet-5-5"))?.id).toBe("fresh");
    expect(pickOverflowMachine([old], opts("claude-sonnet-5-5"))).toBeNull();
  });

  it("is still chosen when it never reported its models, or the model is an alias", () => {
    expect(machineLacksModel(node({}), "claude-sonnet-5-5")).toBe(false);
    expect(machineLacksModel(node({ models: ["claude-opus-5"] }), "sonnet")).toBe(false);
    expect(machineLacksModel(node({ models: ["claude-opus-5"] }), null)).toBe(false);
    expect(machineLacksModel(node({ models: ["claude-opus-5"] }), "claude-code:claude-sonnet-5-5")).toBe(true);
  });

  it("reads a prefixed model against the list, and leaves Codex and Muse cards alone", () => {
    const n = node({ models: ["claude-sonnet-5-5"] });
    expect(machineLacksModel(n, "claude-code:claude-sonnet-5-5")).toBe(false);
    expect(machineLacksModel(n, "codex:gpt-5")).toBe(false);
    expect(machineLacksModel(n, "muse:whatever")).toBe(false);
  });

  it("reads values without a prefix the way the runner does", () => {
    const n = node({ models: ["claude-sonnet-5-5"] });
    expect(machineLacksModel(n, "gpt-5.1-codex")).toBe(false);
    expect(machineLacksModel(n, "codex")).toBe(false);
    expect(machineLacksModel(n, "claude-opus-5-5")).toBe(true);
  });

  it("reads the node's refusal wording as a verdict on the machine", () => {
    expect(isModelUnavailable('Avvio agent fallito ripetutamente. Motivo: No coding agent is available for model "claude-sonnet-5-5".')).toBe(true);
    expect(isModelUnavailable('The selected coding runtime Claude Code cannot run model "claude-sonnet-5-5".')).toBe(true);
    expect(isModelUnavailable(new Error("git worktree failed"))).toBe(false);
  });
});
